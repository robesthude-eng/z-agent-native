import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

const SOCKET_PATH = process.env.Z_AGENT_BROWSER_SOCKET || '/run/z-agent-browser/browser.sock';
// Запрос на рендер несёт всю страницу целиком: HTML с вклеенными data:-картинками
// легко переваливает за два мегабайта, а отказ выглядит как сломанный рендер.
const MAX_BODY = 8 * 1024 * 1024;
const IDLE_MS = Math.min(Math.max(Number(process.env.Z_AGENT_BROWSER_IDLE_MS) || 10 * 60 * 1000, 60_000), 60 * 60 * 1000);
const MAX_WORKERS = Math.min(Math.max(Number(process.env.Z_AGENT_BROWSER_MAX_WORKERS) || 16, 1), 64);
const MAX_PENDING_PER_WORKER = Math.min(Math.max(Number(process.env.Z_AGENT_BROWSER_MAX_PENDING_PER_WORKER) || 2, 1), 8);
const SETPRIV = ['/usr/bin/setpriv', '/bin/setpriv', '/sbin/setpriv'].find((candidate) => fs.existsSync(candidate)) || null;
const ENV = ['/usr/bin/env', '/bin/env'].find((candidate) => fs.existsSync(candidate)) || null;
const WORKER_FILE = path.resolve(new URL('./browser-worker.mjs', import.meta.url).pathname);
const RESPONSE_PREFIX = 'ZAGENT_BROWSER_RESPONSE ';
const workers = new Map();
if (!SETPRIV || !ENV) throw new Error('Isolated browser service requires util-linux setpriv and env');

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(data.length), 'cache-control': 'no-store' });
  res.end(data);
}
async function parseBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Browser request too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}
function identity(value) {
  const uid = Number(value);
  if (!Number.isInteger(uid) || uid < 20000 || uid > 2_000_000_000) throw Object.assign(new Error('Invalid browser sandbox uid'), { statusCode: 400 });
  return uid;
}
function validSessionId(value) {
  const sid = String(value || '');
  if (!/^ses_[A-Za-z0-9]+$/.test(sid)) throw Object.assign(new Error('Invalid browser session id'), { statusCode: 400 });
  return sid;
}
function proxyHealth() {
  const raw = String(process.env.Z_AGENT_BROWSER_PROXY || '').trim();
  if (!raw) return Promise.resolve({ ok: true, configured: false });
  let target;
  try { target = new URL('/health', raw); } catch { return Promise.resolve({ ok: false, configured: true, reason: 'invalid_proxy_url' }); }
  if (target.protocol !== 'http:') return Promise.resolve({ ok: false, configured: true, reason: 'proxy_must_be_http' });
  return new Promise((resolve) => {
    const req = http.get(target, (response) => {
      response.resume();
      resolve({ ok: response.statusCode === 200, configured: true });
    });
    req.setTimeout(1500, () => req.destroy());
    req.on('error', () => resolve({ ok: false, configured: true }));
  });
}

function workerHome(uid) {
  const dir = `/tmp/z-agent-browser-${uid}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chownSync(dir, uid, uid);
  fs.chmodSync(dir, 0o700);
  return dir;
}
function stopWorker(state, signal = 'SIGTERM') {
  if (!state || state.stopping) return;
  state.stopping = true;
  try { state.child.kill(signal); } catch {}
  setTimeout(() => { try { state.child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
}
function rejectPending(state, error) {
  for (const { reject } of state.pending.values()) reject(error);
  state.pending.clear();
}
function startWorker(sessionId, uid) {
  const home = workerHome(uid);
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: process.env.LANG || 'C.UTF-8',
    Z_AGENT_BROWSER_PROXY: String(process.env.Z_AGENT_BROWSER_PROXY || ''),
    Z_AGENT_NETWORK_POLICY: String(process.env.Z_AGENT_NETWORK_POLICY || 'off'),
    Z_AGENT_NETWORK_ALLOWLIST: String(process.env.Z_AGENT_NETWORK_ALLOWLIST || ''),
    PLAYWRIGHT_BROWSERS_PATH: String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright'),
  };
  const envAssignments = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`);
  const child = spawn(SETPRIV, [
    '--clear-groups', '--no-new-privs', `--reuid=${uid}`, `--regid=${uid}`,
    ENV, '-i', '--', ...envAssignments, process.execPath, WORKER_FILE, sessionId,
  ], {
    // Keep privileged launcher environment independent of browser/session data.
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'], detached: false,
  });
  const state = { sessionId, uid, child, home, pending: new Map(), lastUsed: Date.now(), stopping: false, stderr: '' };
  workers.set(sessionId, state);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.startsWith(RESPONSE_PREFIX)) return;
    let message;
    try { message = JSON.parse(line.slice(RESPONSE_PREFIX.length)); } catch { return; }
    const pending = state.pending.get(String(message?.id || ''));
    if (!pending) return;
    state.pending.delete(String(message.id));
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error || 'Browser worker failed'), { code: message.code || 'BROWSER_WORKER_ERROR' }));
  });
  child.stderr.on('data', (chunk) => {
    state.stderr = `${state.stderr}${Buffer.from(chunk).toString('utf8')}`.slice(-16_000);
  });
  const closed = (code, signal) => {
    if (workers.get(sessionId) === state) workers.delete(sessionId);
    rejectPending(state, new Error(`Browser worker exited (${code ?? signal ?? 'unknown'}): ${state.stderr.slice(-1000)}`));
    fs.rmSync(home, { recursive: true, force: true });
  };
  child.once('error', (error) => {
    if (workers.get(sessionId) === state) workers.delete(sessionId);
    rejectPending(state, error);
  });
  child.once('close', closed);
  return state;
}
function ensureWorker(sessionId, uid) {
  const existing = workers.get(sessionId);
  if (existing) {
    if (existing.uid !== uid) throw Object.assign(new Error('Browser sandbox identity mismatch'), { statusCode: 403 });
    if (existing.child.exitCode == null && !existing.stopping) return existing;
    workers.delete(sessionId);
  }
  if (workers.size >= MAX_WORKERS) throw Object.assign(new Error('Browser worker capacity reached'), { statusCode: 429, code: 'BROWSER_BUSY' });
  return startWorker(sessionId, uid);
}
function requestWorker(state, input, req) {
  state.lastUsed = Date.now();
  if (state.pending.size >= MAX_PENDING_PER_WORKER) {
    throw Object.assign(new Error('Browser session is busy'), { statusCode: 429, code: 'BROWSER_BUSY' });
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      stopWorker(state);
      reject(new Error('Browser worker timed out'));
    }, Math.min(Math.max(Number(input?.timeoutMs) || 30_000, 1000), 120_000) + 10_000);
    timer.unref?.();
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    state.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    const abort = () => {
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      stopWorker(state);
      clearTimeout(timer);
      reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
    };
    req.once('aborted', abort);
    req.once('close', () => { if (!req.complete) abort(); });
    state.child.stdin.write(`${JSON.stringify({ id, input })}\n`, (error) => { if (error) abort(); });
  });
}

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const state of workers.values()) if (now - state.lastUsed > IDLE_MS) stopWorker(state);
}, 60_000);
sweepTimer.unref?.();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (req.url === '/health') {
      const proxy = await proxyHealth();
      return json(res, proxy.ok ? 200 : 503, {
        ok: proxy.ok, isolated: true, workerIsolation: 'per-session-setpriv-uid', controllerUid: typeof process.getuid === 'function' ? process.getuid() : null,
        mounts: 'none', egressProxy: proxy.configured && proxy.ok, activeWorkers: workers.size,
        capacity: { maxWorkers: MAX_WORKERS, maxPendingPerWorker: MAX_PENDING_PER_WORKER },
      });
    }
    if (req.url !== '/browser') return json(res, 404, { error: 'Not found' });
    const body = await parseBody(req);
    const sessionId = validSessionId(body.sessionId);
    const uid = identity(body.uid);
    const action = String(body?.input?.action || '').toLowerCase();
    const existing = workers.get(sessionId);
    if (action === 'close' && !existing) return json(res, 200, { result: { output: 'No browser session was open.', title: 'browser close', metadata: { browser: { action: 'close' } } } });
    const state = ensureWorker(sessionId, uid);
    const result = await requestWorker(state, body.input || {}, req);
    if (action === 'close') stopWorker(state);
    return json(res, 200, { result });
  } catch (error) {
    return json(res, Number(error?.statusCode) || 500, { error: error?.message || String(error), code: error?.code || 'BROWSER_SERVICE_ERROR' });
  }
});

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
try { fs.unlinkSync(SOCKET_PATH); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
server.listen(SOCKET_PATH, () => {
  fs.chmodSync(path.dirname(SOCKET_PATH), 0o700);
  fs.chmodSync(SOCKET_PATH, 0o660);
  console.log(`[browser-service] listening on ${SOCKET_PATH}; per-session workers use setpriv UIDs`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(sweepTimer);
  for (const state of workers.values()) stopWorker(state);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref?.();
});
