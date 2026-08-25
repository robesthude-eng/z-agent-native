import { runWebSearch } from '../websearch.mjs';
import { safeExternalRequest } from '../security.mjs';
import { assertAgentNetworkHost, assertAgentNetworkUrl } from '../workspace-policy.mjs';

export async function executeWebSearch(input, signal) {
  const apiKey = String(process.env.BRAVE_SEARCH_API_KEY || '').trim();
  assertAgentNetworkHost(apiKey ? 'api.search.brave.com' : 'api.duckduckgo.com', { tool: 'websearch' });
  return await runWebSearch({
    query: input?.query,
    count: input?.count,
    signal,
    apiKey,
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
  return { output: res.text.slice(0, maxChars), title: String(res.url) };
}
