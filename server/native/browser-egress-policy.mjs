import { assertAgentNetworkUrl } from './workspace-policy.mjs';
import { resolveSafeExternalTarget } from './security.mjs';

export function parseConnectAuthority(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 512 || /[\s/@?#]/.test(text)) throw Object.assign(new Error('Invalid CONNECT authority'), { statusCode: 400 });
  let parsed;
  try { parsed = new URL(`https://${text}/`); } catch { throw Object.assign(new Error('Invalid CONNECT authority'), { statusCode: 400 }); }
  if (parsed.username || parsed.password || !parsed.hostname) throw Object.assign(new Error('Invalid CONNECT authority'), { statusCode: 400 });
  const port = Number(parsed.port || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Invalid CONNECT port'), { statusCode: 400 });
  return { hostname: parsed.hostname.replace(/^\[|\]$/g, ''), port };
}

export async function resolveBrowserEgress(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw Object.assign(new Error('Invalid browser egress URL'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only HTTP(S) browser egress is supported'), { statusCode: 400 });
  assertAgentNetworkUrl(url.href, { tool: 'browser egress' });
  return await resolveSafeExternalTarget(url.href);
}
