import fs from 'node:fs';
import http from 'node:http';
import { BROWSER_ACTIONS, BROWSER_RENDER_ACTIONS, executeBrowserTool as executeBrowserToolLocal } from './browser.mjs';

export { BROWSER_ACTIONS, BROWSER_RENDER_ACTIONS };

// Снимок страницы и текстовый ответ — разные порядки величин. Общий потолок
// пришлось бы ставить по самому большому, и тогда обычный snapshot потерял бы
// защиту от ответа на десятки мегабайт.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RENDER_RESPONSE_BYTES = 32 * 1024 * 1024;
const SOCKET_PATH = process.env.Z_AGENT_BROWSER_SOCKET || '/run/z-agent-browser/browser.sock';
const REQUIRED = process.env.Z_AGENT_BROWSER_REQUIRED === '1';

export function browserServiceAvailable() {
  try { return fs.statSync(SOCKET_PATH).isSocket(); } catch { return false; }
}

function remote(payload, signal, timeoutMs = 130_000, maxBytes = MAX_RESPONSE_BYTES) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const req = http.request({ socketPath: SOCKET_PATH, path: '/browser', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error('Browser service response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { return finish(reject, new Error('Browser service returned invalid JSON')); }
        if ((res.statusCode || 500) >= 400) return finish(reject, Object.assign(new Error(parsed.error || `Browser service HTTP ${res.statusCode}`), { code: parsed.code || 'BROWSER_SERVICE_ERROR' }));
        finish(resolve, parsed.result);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Browser service IPC timeout')), timeoutMs);
    timer.unref?.();
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => finish(reject, error));
    const abort = () => req.destroy(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    req.end(body);
  });
}

export async function executeBrowserTool({ sessionId, uid = null, input = {}, signal }) {
  const isRender = BROWSER_RENDER_ACTIONS.includes(String(input?.action || '').trim().toLowerCase());
  if (browserServiceAvailable()) {
    return await remote(
      { sessionId, uid, input },
      signal,
      Math.min(Math.max(Number(input?.timeoutMs) || 30_000, 1000), 120_000) + 10_000,
      isRender ? MAX_RENDER_RESPONSE_BYTES : MAX_RESPONSE_BYTES,
    );
  }
  if (REQUIRED) throw Object.assign(new Error(`Secure browser service is required but unavailable at ${SOCKET_PATH}`), { code: 'BROWSER_SERVICE_UNAVAILABLE' });
  return await executeBrowserToolLocal({ sessionId, input, signal });
}

export async function closeBrowserSessionRemote(sessionId, uid = null) {
  if (!browserServiceAvailable()) return false;
  try {
    const result = await remote({ sessionId, uid, input: { action: 'close' } }, undefined, 10_000);
    return /closed/i.test(String(result?.output || ''));
  } catch {
    return false;
  }
}

export async function probeBrowserService() {
  if (!browserServiceAvailable()) return { ok: false, reason: 'socket_missing' };
  return await new Promise((resolve) => {
    const req = http.request({ socketPath: SOCKET_PATH, path: '/health', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({ ok: false, reason: 'invalid_json' }); } });
    });
    req.on('error', (error) => resolve({ ok: false, reason: error?.message || String(error) }));
    req.setTimeout(2000, () => req.destroy());
    req.end('{}');
  });
}
