import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSearchRows,
  parseBraveResults,
  parseDuckDuckGoHtml,
  parseDuckDuckGoInstant,
  parseWikipediaOpensearch,
  runWebSearch,
} from '../server/native/websearch.mjs';

process.env.Z_AGENT_NETWORK_POLICY = 'public';

const DDG_HTML = `
<html><body>
  <a rel="nofollow" class="result__a" href="https://en.wikipedia.org/wiki/Draughts">English draughts</a>
  <a class="result__snippet" href="https://en.wikipedia.org/wiki/Draughts">Checkers is a group of strategy board games.</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fplay">Play now</a>
  <div class="result__snippet">A playable board.</div>
  <a class="result__a" href="https://duckduckgo.com/settings">Settings</a>
</body></html>
`;

test('DuckDuckGo HTML parser keeps public results and unwraps uddg links', () => {
  const rows = parseDuckDuckGoHtml(DDG_HTML, 5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://en.wikipedia.org/wiki/Draughts');
  assert.match(rows[0].title, /draughts/i);
  assert.match(rows[0].snippet, /strategy board/i);
  assert.equal(rows[1].url, 'https://www.example.com/play');
  assert.equal(rows[1].title, 'Play now');
});

test('DuckDuckGo Instant Answer parser reads abstract and related topics', () => {
  const rows = parseDuckDuckGoInstant({
    Heading: 'Gukesh Dommaraju',
    Abstract: 'Current world chess champion.',
    AbstractURL: 'https://en.wikipedia.org/wiki/Gukesh_Dommaraju',
    RelatedTopics: [
      { Text: 'World Chess Championship', FirstURL: 'https://en.wikipedia.org/wiki/World_Chess_Championship' },
      { Topics: [{ Text: 'Nested', FirstURL: 'https://en.wikipedia.org/wiki/Chess' }] },
    ],
  }, 5);
  assert.equal(rows[0].url, 'https://en.wikipedia.org/wiki/Gukesh_Dommaraju');
  assert.equal(rows.length, 3);
});

test('Wikipedia OpenSearch parser reads the 4-tuple array', () => {
  const rows = parseWikipediaOpensearch(['q', ['Alpha'], ['desc'], ['https://en.wikipedia.org/wiki/Alpha']], 5);
  assert.deepEqual(rows, [{ title: 'Alpha', url: 'https://en.wikipedia.org/wiki/Alpha', snippet: 'desc' }]);
});

test('Brave parser reads web.results and skips junk URLs', () => {
  const rows = parseBraveResults({
    web: {
      results: [
        { title: 'One', url: 'https://example.org/a', description: 'first' },
        { title: 'Local', url: 'http://localhost/secret', description: 'nope' },
        { title: 'Two', url: 'https://example.org/b', description: 'second' },
      ],
    },
  }, 10);
  assert.deepEqual(rows.map((row) => row.url), ['https://example.org/a', 'https://example.org/b']);
  assert.match(formatSearchRows(rows), /example\.org\/a/);
});

test('runWebSearch uses Brave when a key is present and DuckDuckGo otherwise', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.search.brave.com')) {
      return {
        status: 200,
        text: JSON.stringify({ web: { results: [{ title: 'Brave Hit', url: 'https://example.net/b', description: 'ok' }] } }),
      };
    }
    if (String(url).includes('api.duckduckgo.com')) {
      return {
        status: 200,
        text: JSON.stringify({
          Heading: 'Draughts',
          Abstract: 'Board game',
          AbstractURL: 'https://en.wikipedia.org/wiki/Draughts',
        }),
      };
    }
    if (String(url).includes('ru.wikipedia.org')) {
      return { status: 200, text: JSON.stringify(['q', ['Шахматы'], ['игра'], ['https://ru.wikipedia.org/wiki/Шахматы']]) };
    }
    return { status: 200, text: JSON.stringify(['q', [], [], []]) };
  };

  const brave = await runWebSearch({ query: 'checkers', apiKey: 'test-key', request });
  assert.equal(brave.metadata.websearch.provider, 'brave');
  assert.match(brave.output, /Brave Hit/);
  assert.ok(calls[0].includes('api.search.brave.com'));

  const ddg = await runWebSearch({ query: 'checkers', apiKey: '', request });
  assert.equal(ddg.metadata.websearch.provider, 'duckduckgo');
  assert.match(ddg.output, /en\.wikipedia\.org\/wiki\/Draughts/);
  assert.ok(calls.some((url) => url.includes('api.duckduckgo.com')));
});

test('a year-stuffed query retries without the year', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const q = parsed.searchParams.get('q') || parsed.searchParams.get('search') || '';
    if (/\b2026\b/.test(q)) return { status: 200, text: JSON.stringify({ Heading: '', Abstract: '', RelatedTopics: [] }) };
    if (String(url).includes('api.duckduckgo.com')) {
      return { status: 200, text: JSON.stringify({ Heading: 'World Chess Championship', Abstract: 'Gukesh', AbstractURL: 'https://en.wikipedia.org/wiki/World_Chess_Championship' }) };
    }
    return { status: 200, text: JSON.stringify(['q', [], [], []]) };
  };
  const result = await runWebSearch({ query: 'current world chess champion 2026', apiKey: '', request });
  assert.match(result.output, /World_Chess_Championship/);
  assert.ok(calls.some((url) => url.includes('2026')));
  assert.ok(calls.some((url) => /q=current\+world\+chess\+champion(?:&|$)/.test(url) || decodeURIComponent(url).includes('current world chess champion') && !url.includes('2026')));
});

test('Cyrillic queries search Russian Wikipedia when Instant Answer is empty', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.duckduckgo.com')) {
      return { status: 200, text: JSON.stringify({ Heading: '', Abstract: '', RelatedTopics: [] }) };
    }
    if (String(url).includes('ru.wikipedia.org')) {
      return { status: 200, text: JSON.stringify(['q', ['Чемпион мира по шахматам'], ['титул'], ['https://ru.wikipedia.org/wiki/Чемпион_мира_по_шахматам']]) };
    }
    return { status: 200, text: JSON.stringify(['q', [], [], []]) };
  };
  const result = await runWebSearch({ query: 'чемпион мира по шахматам', apiKey: '', request });
  assert.match(result.output, /ru\.wikipedia\.org/);
  assert.ok(calls.some((url) => url.includes('ru.wikipedia.org')));
  const wikiOrder = calls.filter((url) => url.includes('wikipedia.org')).map((url) => (url.includes('ru.wikipedia.org') ? 'ru' : 'en'));
  assert.equal(wikiOrder[0], 'ru');
});

test('a live question falls back to real DuckDuckGo web results', async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(String(url));
    if (String(url).includes('html.duckduckgo.com')) {
      return {
        status: 200,
        text: '<a class="result__a" href="https://www.gismeteo.ru/weather-priozersk-11014/">Погода в Приозерске</a><div class="result__snippet">+18°C, облачно</div>',
      };
    }
    return { status: 200, text: JSON.stringify({ Heading: '', Abstract: '', RelatedTopics: [] }) };
  };
  const result = await runWebSearch({ query: 'погода Приозерск Ленинградская область сегодня', apiKey: '', request });
  assert.match(result.output, /gismeteo/);
  assert.equal(result.metadata.websearch.count, 1);
  assert.ok(calls[0].includes('html.duckduckgo.com'));
});

test('a search that finds nothing returns an empty result, not an error', async () => {
  const request = async () => ({ status: 200, text: JSON.stringify({ Heading: '', Abstract: '', RelatedTopics: [] }) });
  const result = await runWebSearch({ query: 'zzqq несуществующий запрос сегодня', apiKey: '', request });
  assert.equal(result.metadata.websearch.empty, true);
  assert.equal(result.metadata.websearch.count, 0);
  assert.match(result.output, /No web results/i);
  assert.match(result.output, /not a failure/i);
});

test('an empty Brave answer falls through to the keyless providers', async () => {
  const request = async (url) => {
    if (String(url).includes('api.search.brave.com')) return { status: 200, text: JSON.stringify({ web: { results: [] } }) };
    if (String(url).includes('html.duckduckgo.com')) return { status: 200, text: '<a class="result__a" href="https://example.org/hit">Hit</a>' };
    return { status: 200, text: JSON.stringify({}) };
  };
  const result = await runWebSearch({ query: 'a rare live question', apiKey: 'test-key', request });
  assert.match(result.output, /example\.org\/hit/);
});

test('time words are dropped in a later query variant', async () => {
  const queries = [];
  const request = async (url) => {
    const parsed = new URL(url);
    const q = parsed.searchParams.get('q') || parsed.searchParams.get('search') || '';
    queries.push(q);
    if (String(url).includes('html.duckduckgo.com') && !/сегодня/.test(q)) {
      return { status: 200, text: '<a class="result__a" href="https://example.net/now">Now</a>' };
    }
    return { status: 200, text: JSON.stringify({}) };
  };
  const result = await runWebSearch({ query: 'курс валют в Москве сегодня', apiKey: '', request });
  assert.match(result.output, /example\.net\/now/);
  assert.ok(queries.some((item) => /сегодня/.test(item)));
  assert.ok(queries.some((item) => item && !/сегодня/.test(item)));
});

test('runWebSearch refuses an empty query', async () => {
  await assert.rejects(() => runWebSearch({ query: '  ', request: async () => ({ status: 200, text: '' }) }), /query must not be empty/);
});
