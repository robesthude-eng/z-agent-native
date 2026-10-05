import { htmlToReadableText, looksLikeHtml } from '../html-text.mjs';
import { safeExternalRequest } from '../security.mjs';
import { runWebSearch } from '../websearch.mjs';
import { assertAgentNetworkHost, assertAgentNetworkUrl } from '../workspace-policy.mjs';

export async function executeWebSearch(input, signal) {
  const apiKey = String(process.env.BRAVE_SEARCH_API_KEY || '').trim();
  assertAgentNetworkHost(apiKey ? 'api.search.brave.com' : 'api.duckduckgo.com', { tool: 'websearch' });
  return await runWebSearch({
    query: input?.query,
    count: input?.count,
    signal,
    apiKey,
    searxngUrl: process.env.Z_AGENT_SEARXNG_URL,
  });
}

export async function executeWebFetch(input, signal) {
  assertAgentNetworkUrl(input?.url, { tool: 'webfetch' });
  const maxChars = Math.min(Math.max(Number(input?.maxChars) || 50000, 1000), 200000);
  const res = await safeExternalRequest(input?.url, {
    headers: { 'user-agent': 'Z-Agent-Native/1.0', accept: 'text/plain,text/html,application/json;q=0.9,*/*;q=0.5' },
    signal,
    maxBytes: Math.max(maxChars * 4, 1024 * 1024),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 500)}`);
  const contentType = headerValue(res.headers, 'content-type');
  if (input?.format === 'html' || !looksLikeHtml(contentType, res.text)) {
    return { output: res.text.slice(0, maxChars), title: String(res.url) };
  }
  const page = htmlToReadableText(res.text, { baseUrl: String(res.url) });
  const parts = [page.title ? `# ${page.title}` : '', page.description ? `> ${page.description}` : '', page.text].filter(Boolean);
  let output = parts.join('\n\n');
  if (page.text.length < 300 && res.text.length > 5_000) {
    output += '\n\n[webfetch: almost no text in the HTML — the page is probably rendered by JavaScript. Use the browser tool to read it, or format="html" for the raw markup.]';
  }
  if (output.length > maxChars) output = `${output.slice(0, maxChars)}\n\n[webfetch: text truncated at ${maxChars} characters; raise maxChars to read further.]`;
  return { output, title: page.title || String(res.url) };
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}
