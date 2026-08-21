import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSearchRows, parseBraveResults, parseDuckDuckGoHtml, runWebSearch } from '../server/native/websearch.mjs';

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
    return { status: 200, text: DDG_HTML };
  };

  const brave = await runWebSearch({ query: 'checkers', apiKey: 'test-key', request });
  assert.equal(brave.metadata.websearch.provider, 'brave');
  assert.match(brave.output, /Brave Hit/);
  assert.ok(calls[0].includes('api.search.brave.com'));

  const ddg = await runWebSearch({ query: 'checkers', apiKey: '', request });
  assert.equal(ddg.metadata.websearch.provider, 'duckduckgo');
  assert.match(ddg.output, /en\.wikipedia\.org\/wiki\/Draughts/);
  assert.ok(calls[1].includes('html.duckduckgo.com'));
});

test('runWebSearch refuses an empty query', async () => {
  await assert.rejects(() => runWebSearch({ query: '  ', request: async () => ({ status: 200, text: '' }) }), /query must not be empty/);
});
