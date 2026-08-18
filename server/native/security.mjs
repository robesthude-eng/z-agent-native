import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;

/** Single source of truth for session identifiers across HTTP, socket and job code. */
export function isSessionId(value) {
  return SESSION_ID_PATTERN.test(String(value || ''));
}

export function assertSessionId(value, message = 'Invalid session id') {
  const id = String(value || '');
  if (!isSessionId(id)) throw Object.assign(new Error(message), { statusCode: 400 });
  return id;
}

export function safeWorkspacePath(root, input = '.', { allowMissing = true } = {}) {
  const raw = String(input || '.');
  if (raw.includes('\0')) throw Object.assign(new Error('Некорректный путь'), { statusCode: 400 });
  if (path.isAbsolute(raw)) throw Object.assign(new Error('Разрешены только относительные пути workspace'), { statusCode: 400 });
  const base = path.resolve(root);
  const target = path.resolve(base, raw);
  if (target !== base && !target.startsWith(base + path.sep)) throw Object.assign(new Error('Путь выходит за пределы workspace'), { statusCode: 403 });

  // Не разрешаем проход через symlink: агент не должен выйти из sandbox через
  // заранее подготовленный link в проекте.
  const rel = path.relative(base, target);
  let cur = base;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, segment);
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) throw Object.assign(new Error('Symlink-пути запрещены'), { statusCode: 403 });
    } catch (err) {
      if (err?.code === 'ENOENT' && allowMissing) break;
      throw err;
    }
  }
  return target;
}

function ipv4Private(ip) {
  const [a,b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function ipBlocked(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? ipv4Private(mapped[1]) : false;
}

/** Hostnames that must never be reached through a relay or provider base URL. */
export function isLoopbackOrPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') return true;
  if (net.isIP(host)) return ipBlocked(host);
  return false;
}

/**
 * Validate an external URL and return the exact address the request must use.
 * Pinning the resolved address is what closes the DNS-rebinding window between
 * validation and connect.
 */
export async function resolveSafeExternalTarget(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw Object.assign(new Error('Некорректный URL'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Разрешены только http/https URL'), { statusCode: 400 });
  if (url.username || url.password) throw Object.assign(new Error('Credentials в URL запрещены'), { statusCode: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.toLowerCase().endsWith('.localhost')) throw Object.assign(new Error('Локальные и служебные адреса запрещены'), { statusCode: 403 });
  if (net.isIP(host)) {
    if (ipBlocked(host)) throw Object.assign(new Error('Локальные и служебные адреса запрещены'), { statusCode: 403 });
    return { url, address: host, family: net.isIPv6(host) ? 6 : 4 };
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some((a) => ipBlocked(a.address))) throw Object.assign(new Error('URL разрешается в локальную/служебную сеть'), { statusCode: 403 });
  const first = answers[0];
  return { url, address: first.address, family: Number(first.family) === 6 ? 6 : 4 };
}

export async function assertSafeExternalUrl(value) {
  const { url } = await resolveSafeExternalTarget(value);
  return url;
}

/**
 * GET an external resource with the destination address pinned to the one that
 * passed the SSRF checks, so a second DNS answer cannot redirect the socket to
 * an internal service. Redirects are refused, bodies are hard-bounded.
 */
async function pinnedRequest({ url, address, family }, { headers = {}, signal, maxBytes = 5 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
  const transport = url.protocol === 'https:' ? https : http;
  const options = {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { host: url.host, 'accept-encoding': 'identity', ...headers },
    timeout: timeoutMs,
    lookup: (_hostname, opts, cb) => (opts?.all
      ? cb(null, [{ address, family }])
      : cb(null, address, family)),
  };
  if (url.protocol === 'https:' && !net.isIP(url.hostname)) options.servername = url.hostname;

  return await new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const status = Number(res.statusCode) || 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        reject(Object.assign(new Error(`Redirects are not followed (HTTP ${status})`), { statusCode: 502 }));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          resolve({ url, status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), truncated: true });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ url, status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), truncated: false }));
      res.on('error', reject);
    });
    const abort = () => req.destroy(Object.assign(new Error('Request aborted'), { statusCode: 499 }));
    if (signal) {
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    req.on('timeout', () => req.destroy(Object.assign(new Error('Request timed out'), { statusCode: 504 })));
    req.on('error', reject);
    req.end();
  });
}

let externalTransport = pinnedRequest;

/**
 * Test seam. URL validation always runs in safeExternalRequest; only the socket
 * layer below it can be replaced, so tests can never opt out of the SSRF guard.
 */
export function setExternalTransportForTests(fn) {
  externalTransport = typeof fn === 'function' ? fn : pinnedRequest;
}

export async function safeExternalRequest(value, options = {}) {
  const target = await resolveSafeExternalTarget(value);
  return await externalTransport(target, options);
}
