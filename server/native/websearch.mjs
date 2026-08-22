import { safeExternalRequest } from './security.mjs';
import { assertAgentNetworkUrl } from './workspace-policy.mjs';

const SEARCH_UA = 'Z-Agent-Native/1.0';
// HTML-выдача DuckDuckGo отвечает заглушкой на служебный User-Agent,
// поэтому для неё нужен обычный браузерный заголовок.
const HTML_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIME_FILLER = /\b(?:сегодня|сейчас|завтра|вчера|актуальны?е?й?ы?е?|температура\s+на|today|right\s+now|now|latest|current)\b/gi;
const MAX_COUNT = 10;

function boundedCount(value) {
  return Math.min(Math.max(Number(value) || 5, 1), MAX_COUNT);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isInteger(n) && n >= 32 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const n = Number.parseInt(code, 16);
      return Number.isInteger(n) && n >= 32 && n < 0x110000 ? String.fromCodePoint(n) : '';
    });
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function decodeDuckDuckGoHref(href) {
  const raw = decodeHtml(String(href || '').trim());
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://duckduckgo.com/');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return uddg;
    return url.href;
  } catch {
    return raw;
  }
}

function isPublicResultUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!/^https?:$/i.test(url.protocol)) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
    if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) return false;
    return true;
  } catch {
    return false;
  }
}

function pushRow(rows, seen, item, limit) {
  if (rows.length >= limit) return;
  const url = String(item?.url || '').trim();
  const title = String(item?.title || '').trim() || url;
  if (!isPublicResultUrl(url) || !title || seen.has(url)) return;
  seen.add(url);
  rows.push({
    title,
    url,
    snippet: String(item?.snippet || '').trim(),
  });
}

export function parseBraveResults(body, count = 5) {
  const limit = boundedCount(count);
  const rows = [];
  const seen = new Set();
  for (const row of body?.web?.results || []) {
    pushRow(rows, seen, {
      title: row?.title || row?.url,
      url: row?.url,
      snippet: row?.description || '',
    }, limit);
  }
  return rows;
}

export function parseDuckDuckGoInstant(body, count = 5) {
  const limit = boundedCount(count);
  const rows = [];
  const seen = new Set();
  const heading = String(body?.Heading || '').trim();
  const abstract = String(body?.Abstract || body?.AbstractText || '').trim();
  if (body?.AbstractURL) {
    pushRow(rows, seen, { title: heading || body.AbstractURL, url: body.AbstractURL, snippet: abstract }, limit);
  }
  for (const row of body?.Results || []) {
    pushRow(rows, seen, { title: row?.Text || row?.FirstURL, url: row?.FirstURL, snippet: row?.Text || '' }, limit);
  }
  const walk = (topics) => {
    for (const topic of topics || []) {
      if (rows.length >= limit) return;
      if (topic?.FirstURL) pushRow(rows, seen, { title: topic.Text || topic.FirstURL, url: topic.FirstURL, snippet: topic.Text || '' }, limit);
      if (Array.isArray(topic?.Topics)) walk(topic.Topics);
    }
  };
  walk(body?.RelatedTopics);
  return rows;
}

export function parseWikipediaOpensearch(body, count = 5) {
  const limit = boundedCount(count);
  const rows = [];
  const seen = new Set();
  const titles = Array.isArray(body?.[1]) ? body[1] : [];
  const snippets = Array.isArray(body?.[2]) ? body[2] : [];
  const urls = Array.isArray(body?.[3]) ? body[3] : [];
  for (let i = 0; i < urls.length && rows.length < limit; i++) {
    pushRow(rows, seen, { title: titles[i] || urls[i], url: urls[i], snippet: snippets[i] || '' }, limit);
  }
  return rows;
}

export function parseDuckDuckGoHtml(html, count = 5) {
  const limit = boundedCount(count);
  const rows = [];
  const seen = new Set();
  const source = String(html || '');
  const anchors = source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
  for (const match of anchors) {
    if (rows.length >= limit) break;
    const attrs = match[1] || '';
    if (!/\bclass\s*=\s*["'][^"']*\bresult__a\b/i.test(attrs)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const url = decodeDuckDuckGoHref(href);
    const title = stripTags(match[2]);
    let snippet = '';
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 1200);
    const snippetMatch = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i);
    if (snippetMatch) snippet = stripTags(snippetMatch[1]);
    pushRow(rows, seen, { title, url, snippet }, limit);
  }
  return rows;
}

export function formatSearchRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, i) => {
    const lines = [`${i + 1}. ${row.title || row.url}`, row.url];
    if (row.snippet) lines.push(row.snippet);
    return lines.join('\n');
  }).join('\n\n');
}

/** Policy refusals are configuration outcomes, not source failures. */
export function isNetworkPolicyBlock(error) {
  const code = String(error?.code || '');
  return code === 'AGENT_NETWORK_BLOCKED' || code === 'AGENT_NETWORK_HOST_BLOCKED' || code === 'AGENT_NETWORK_URL_INVALID';
}

/**
 * Real DuckDuckGo web results.
 *
 * The Instant Answer API only serves curated answers, so it is empty for most
 * live questions ("погода <город> сегодня"), and Wikipedia OpenSearch only
 * matches article titles. The HTML endpoint is the only keyless source that
 * answers such queries; its parser already existed here but was never wired
 * into a request, which is why websearch reported a hard error instead of
 * results.
 */
async function searchDuckDuckGoHtml(q, n, fetchUrl, signal) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', q);
  url.searchParams.set('kl', /[\u0400-\u04FF]/.test(q) ? 'ru-ru' : 'wt-wt');
  assertAgentNetworkUrl(url.toString(), { tool: 'websearch' });
  const res = await fetchUrl(url.toString(), {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent': HTML_UA,
    },
    signal,
    maxBytes: 4 * 1024 * 1024,
  });
  if (res.status < 200 || res.status >= 300) return [];
  return parseDuckDuckGoHtml(String(res.text || ''), n);
}

/**
 * Brave when an API key is configured; otherwise the DuckDuckGo HTML results,
 * then Instant Answer plus Wikipedia OpenSearch. Callers must already have
 * passed the agent network policy gate for the host that will actually be
 * contacted.
 */
function queryVariants(query) {
  const q = String(query || '').trim();
  const out = [];
  const push = (value) => {
    const next = String(value || '').replace(/\s+/g, ' ').trim();
    if (next && !out.includes(next)) out.push(next);
  };
  push(q);
  push(q.replace(/\b20\d{2}\b/g, ' '));
  // Живые вопросы содержат уточнения времени и региона, из-за которых
  // справочные источники не находят ничего. Перед тем как признать поиск
  // пустым, сокращаем запрос до смыслового ядра.
  const core = q.replace(TIME_FILLER, ' ');
  push(core);
  const words = core.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const proper = words.filter((word) => /^[A-ZА-ЯЁ]/.test(word));
  if (proper.length && proper.length < words.length) push(proper.join(' '));
  if (words.length > 2) push(words.slice(0, 2).join(' '));
  return out;
}

async function collectPublicResults(q, n, fetchUrl, signal) {
  const rows = [];
  const seen = new Set();
  const merge = (items) => {
    for (const item of items || []) pushRow(rows, seen, item, n);
  };

  const instantUrl = new URL('https://api.duckduckgo.com/');
  instantUrl.searchParams.set('q', q);
  instantUrl.searchParams.set('format', 'json');
  instantUrl.searchParams.set('no_html', '1');
  instantUrl.searchParams.set('skip_disambig', '1');
  assertAgentNetworkUrl(instantUrl.toString(), { tool: 'websearch' });
  const instant = await fetchUrl(instantUrl.toString(), {
    headers: { accept: 'application/json', 'user-agent': SEARCH_UA },
    signal,
    maxBytes: 2 * 1024 * 1024,
  });
  if (instant.status >= 200 && instant.status < 300) {
    try { merge(parseDuckDuckGoInstant(JSON.parse(String(instant.text || '{}')), n)); } catch { /* fall through */ }
  }

  if (rows.length < n) {
    const cyrillic = /[\u0400-\u04FF]/.test(q);
    const hosts = cyrillic ? ['ru.wikipedia.org', 'en.wikipedia.org'] : ['en.wikipedia.org', 'ru.wikipedia.org'];
    for (const host of hosts) {
      if (rows.length >= n) break;
      const wikiUrl = new URL(`https://${host}/w/api.php`);
      wikiUrl.searchParams.set('action', 'opensearch');
      wikiUrl.searchParams.set('search', q);
      wikiUrl.searchParams.set('limit', String(n));
      wikiUrl.searchParams.set('namespace', '0');
      wikiUrl.searchParams.set('format', 'json');
      assertAgentNetworkUrl(wikiUrl.toString(), { tool: 'websearch' });
      const wiki = await fetchUrl(wikiUrl.toString(), {
        headers: { accept: 'application/json', 'user-agent': SEARCH_UA },
        signal,
        maxBytes: 2 * 1024 * 1024,
      });
      if (wiki.status >= 200 && wiki.status < 300) {
        try { merge(parseWikipediaOpensearch(JSON.parse(String(wiki.text || '[]')), n)); } catch { /* ignore */ }
      }
    }
  }
  return rows;
}

/**
 * Zero results is a normal outcome, not a tool failure. Throwing here painted
 * the whole turn red in chat and pushed the model into error recovery instead
 * of simply narrowing the query.
 */
function emptyResult(q, variants, notes) {
  const lines = [
    `No web results for "${q}".`,
    variants.length > 1 ? `Tried query variants: ${variants.map((item) => `"${item}"`).join(', ')}.` : '',
    notes.length ? `Source notes: ${notes.join('; ')}.` : '',
    'This is an empty result, not a failure. Narrow or rephrase the query, or use webfetch on a specific URL you already know.',
  ].filter(Boolean);
  return {
    output: lines.join('\n'),
    title: q,
    metadata: { websearch: { provider: 'duckduckgo', count: 0, empty: true, variants, notes } },
  };
}

export async function runWebSearch({ query, count, signal, apiKey = '', request = safeExternalRequest } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query must not be empty');
  const n = boundedCount(count);
  const key = String(apiKey || '').trim();
  const fetchUrl = typeof request === 'function' ? request : safeExternalRequest;

  if (key) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', q);
    url.searchParams.set('count', String(n));
    const res = await fetchUrl(url.toString(), {
      headers: { accept: 'application/json', 'x-subscription-token': key, 'user-agent': SEARCH_UA },
      signal,
      maxBytes: 2 * 1024 * 1024,
    });
    const text = String(res?.text || '');
    if (res.status < 200 || res.status >= 300) throw new Error(`Brave Search HTTP ${res.status}: ${text.slice(0, 500)}`);
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('Brave Search returned invalid JSON'); }
    const rows = parseBraveResults(body, n);
    // Пустой ответ платного источника — повод доиграть запрос на бесплатных,
    // а не отказывать всему инструменту.
    if (rows.length) return { output: formatSearchRows(rows), title: q, metadata: { websearch: { provider: 'brave', count: rows.length } } };
  }

  const variants = queryVariants(q);
  const notes = [];
  const blocks = [];
  let rows = [];
  let source = '';
  for (const variant of variants) {
    const steps = [
      { name: 'duckduckgo-html', run: () => searchDuckDuckGoHtml(variant, n, fetchUrl, signal) },
      { name: 'duckduckgo-instant+wikipedia', run: () => collectPublicResults(variant, n, fetchUrl, signal) },
    ];
    for (const step of steps) {
      try {
        const found = await step.run();
        if (found.length) {
          rows = found;
          source = step.name;
          break;
        }
      } catch (error) {
        // Один недоступный или не разрешённый источник не должен ронять весь поиск.
        if (isNetworkPolicyBlock(error)) blocks.push(error);
        else notes.push(`${step.name}: ${String(error?.message || error).slice(0, 200)}`);
      }
    }
    if (rows.length) break;
  }
  // Если политика закрыла все источники, это отказ конфигурации: остаёмся fail-closed.
  if (!rows.length && blocks.length && !notes.length) throw blocks[0];
  if (!rows.length) return emptyResult(q, variants, notes);
  return {
    output: formatSearchRows(rows),
    title: q,
    metadata: { websearch: { provider: 'duckduckgo', source, count: rows.length } },
  };
}
