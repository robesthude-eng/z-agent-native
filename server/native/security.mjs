import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';

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

function coerceWorkspaceRelativePath(root, input = '.') {
  let raw = String(input ?? '.').trim() || '.';
  if (raw.includes('\0')) throw Object.assign(new Error('Некорректный путь'), { statusCode: 400 });
  raw = raw.replace(/\\/g, '/');
  if (/^workspace:/i.test(raw)) {
    raw = raw.replace(/^workspace:\/+/i, '');
  }
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'file:') throw new Error('not file');
      raw = decodeURIComponent(url.pathname || '') || '.';
    } catch {
      throw Object.assign(new Error('Некорректный путь'), { statusCode: 400 });
    }
  }
  const base = path.resolve(root);
  if (path.isAbsolute(raw)) {
    const resolvedAbs = path.resolve(raw);
    if (resolvedAbs === base || resolvedAbs.startsWith(`${base}${path.sep}`)) {
      raw = path.relative(base, resolvedAbs) || '.';
    } else {
      const tmp = raw.match(/^\/(?:private\/)?(?:var\/)?tmp\/(.*)$/i);
      if (tmp) raw = tmp[1] || '.';
      else if (/^\/(?:private\/)?(?:var\/)?tmp\/?$/i.test(raw)) raw = '.';
      else if (/^\/+workspace\//i.test(raw)) raw = raw.replace(/^\/+workspace\/+/i, '') || '.';
      else throw Object.assign(new Error('Разрешены только относительные пути workspace'), { statusCode: 400 });
    }
  }
  return raw;
}

export function safeWorkspacePath(root, input = '.', { allowMissing = true } = {}) {
  const raw = coerceWorkspaceRelativePath(root, input);
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
  const [a,b,c] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Protocol assignments, documentation and benchmarking networks are not
  // public provider destinations even though they are not RFC1918 ranges.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6Words(ip) {
  let source = String(ip || '').toLowerCase().split('%')[0];
  if (source.includes('.')) {
    const split = source.lastIndexOf(':');
    const octets = source.slice(split + 1).split('.').map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
    source = `${source.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

function ipBlocked(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const words = ipv6Words(ip);
  if (!words) return true;
  const first = words[0];
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  // IPv4-compatible/mapped forms must inherit IPv4 blocking. Public mapped
  // forms are allowed; loopback/private hex notation is not a bypass.
  const compatible = words.slice(0, 6).every((word) => word === 0);
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (compatible || mapped) {
    const embedded = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return ipv4Private(embedded);
  }
  // Documentation, transition and translation prefixes are unsuitable for a
  // direct public endpoint and can encode a second destination.
  if (first === 0x2001 && words[1] === 0x0db8) return true;
  if (first === 0x2001 && words[1] === 0x0000) return true; // Teredo
  if (first === 0x2002) return true; // 6to4
  if (first === 0x0064 && words[1] === 0xff9b) return true; // NAT64 WKP
  return false;
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
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const req = transport.request(options, (res) => {
      const status = Number(res.statusCode) || 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        finish(reject, Object.assign(new Error(`Redirects are not followed (HTTP ${status})`), { statusCode: 502 }));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          finish(resolve, { url, status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), truncated: true });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, { url, status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), truncated: false }));
      res.on('error', (err) => finish(reject, err));
    });
    const abort = () => {
      const err = Object.assign(new Error('Request aborted'), { name: 'AbortError', statusCode: 499 });
      req.destroy();
      finish(reject, err);
    };
    if (signal) {
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    req.on('timeout', () => {
      const err = Object.assign(new Error('Request timed out'), { statusCode: 504 });
      req.destroy();
      finish(reject, err);
    });
    req.on('error', (err) => finish(reject, err));
    req.end();
  });
}

/**
 * Fetch-compatible request for provider traffic. Unlike a validate-then-fetch
 * sequence, the socket lookup is pinned to the exact public address that was
 * validated, so a second DNS answer cannot redirect the connection.
 * Redirects are returned to the caller and are never followed implicitly.
 */
async function pinnedFetch({ url, address, family }, init = {}) {
  const transport = url.protocol === 'https:' ? https : http;
  const headers = { 'accept-encoding': 'identity', ...(init.headers || {}) };
  const options = {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: String(init.method || 'GET').toUpperCase(),
    headers: { host: url.host, ...headers },
    lookup: (_hostname, opts, cb) => (opts?.all
      ? cb(null, [{ address, family }])
      : cb(null, address, family)),
  };
  if (url.protocol === 'https:' && !net.isIP(url.hostname)) options.servername = url.hostname;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => init.signal?.removeEventListener('abort', abort);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const req = transport.request(options, (res) => {
      const status = Number(res.statusCode) || 0;
      const body = ['HEAD'].includes(String(init.method || 'GET').toUpperCase()) || [204, 205, 304].includes(status)
        ? null
        : Readable.toWeb(res);
      const response = new Response(body, {
        status,
        statusText: res.statusMessage || '',
        headers: res.headers,
      });
      // Keep the abort listener until the response body closes. Fetch callers
      // may abort while consuming a long SSE stream, after headers arrived.
      res.once('end', cleanup);
      res.once('close', cleanup);
      if (!settled) {
        settled = true;
        resolve(response);
      }
    });
    const abort = () => req.destroy(Object.assign(new Error('Request aborted'), { name: 'AbortError', statusCode: 499 }));
    if (init.signal) {
      if (init.signal.aborted) { abort(); return; }
      init.signal.addEventListener('abort', abort, { once: true });
    }
    req.once('error', (err) => finish(reject, err));
    const body = init.body;
    if (body === undefined || body === null) req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) req.end(body);
    else {
      req.destroy();
      finish(reject, new TypeError('Pinned external requests accept only string or byte bodies'));
    }
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

let externalFetchTransport = pinnedFetch;

/** Test seam below URL validation; production always uses pinnedFetch. */
export function setExternalFetchTransportForTests(fn) {
  externalFetchTransport = typeof fn === 'function' ? fn : pinnedFetch;
}

export async function safeExternalFetch(value, init = {}) {
  const target = await resolveSafeExternalTarget(value);
  return await externalFetchTransport(target, init);
}
