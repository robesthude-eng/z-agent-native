import { safeExternalRequest } from './security.mjs';
import { assertAgentNetworkUrl } from './workspace-policy.mjs';

const SEARCH_UA = 'Z-Agent-Native/1.0';
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

/**
 * Brave when an API key is configured; otherwise DuckDuckGo HTML search.
 * Callers must already have passed the agent network policy gate for the
 * host that will actually be contacted.
 */
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
    if (!rows.length) throw new Error('Web search returned no results. Try a more specific query.');
    return { output: formatSearchRows(rows), title: q, metadata: { websearch: { provider: 'brave', count: rows.length } } };
  }

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
    const wikiUrl = new URL('https://en.wikipedia.org/w/api.php');
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

  if (!rows.length) throw new Error('Web search returned no results. Try a more specific query.');
  return { output: formatSearchRows(rows), title: q, metadata: { websearch: { provider: 'duckduckgo', count: rows.length } } };
}
