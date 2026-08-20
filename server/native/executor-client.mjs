import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOCKET_PATH = process.env.Z_AGENT_EXECUTOR_SOCKET || '/run/z-agent-executor/executor.sock';
const REQUIRED = process.env.Z_AGENT_EXECUTOR_REQUIRED === '1';
const SYNC_HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../executor-sync-client.mjs');

export function executorSocketPath() { return SOCKET_PATH; }
export function executorRequired() { return REQUIRED; }
export function executorAvailable() {
  try { return fs.statSync(SOCKET_PATH).isSocket(); } catch { return false; }
}

function requestExecutor(pathname, payload, { signal, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          req.destroy(new Error('Executor response exceeded 4 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { return finish(reject, new Error('Executor returned invalid JSON')); }
        if ((res.statusCode || 500) >= 400) {
          const error = new Error(parsed?.error || `Executor HTTP ${res.statusCode}`);
          error.code = parsed?.code || 'EXECUTOR_ERROR';
          return finish(reject, error);
        }
        finish(resolve, parsed);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`Executor IPC timed out after ${timeoutMs} ms`)), Math.max(1000, timeoutMs));
    timer.unref?.();
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => finish(reject, error));
    const abort = () => req.destroy(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    req.end(body);
  });
}

export async function executeInExecutor({ workspace, uid, gid = uid, file, args = [], env = {}, stdin = '', timeoutMs, signal }) {
  if (!executorAvailable()) {
    if (REQUIRED) throw Object.assign(new Error(`Secure executor is required but unavailable at ${SOCKET_PATH}`), { code: 'EXECUTOR_UNAVAILABLE' });
    return null;
  }
  return await requestExecutor('/exec', {
    workspace,
    uid,
    gid,
    file,
    args,
    env,
    stdin,
    timeoutMs,
  }, { signal, timeoutMs: Math.min(Math.max(Number(timeoutMs) || 600_000, 5_000) + 10_000, 1_810_000) });
}

export function executeInExecutorSync({ workspace, uid, gid = uid, file, args = [], env = {}, stdin = '', timeoutMs }) {
  if (!executorAvailable()) {
    if (REQUIRED) throw Object.assign(new Error(`Secure executor is required but unavailable at ${SOCKET_PATH}`), { code: 'EXECUTOR_UNAVAILABLE' });
    return null;
  }
  const budget = Math.min(Math.max(Number(timeoutMs) || 60_000, 1_000), 1_800_000);
  const payload = { workspace, uid, gid, file, args, env, stdin, timeoutMs: budget };
  const child = spawnSync(process.execPath, [SYNC_HELPER], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: budget + 15_000, maxBuffer: 5 * 1024 * 1024,
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', Z_AGENT_EXECUTOR_SOCKET: SOCKET_PATH },
  });
  if (child.error) throw child.error;
  if ((child.status ?? 1) !== 0) throw Object.assign(new Error(String(child.stderr || child.stdout || `Executor sync helper exited ${child.status}`).trim()), { code: 'EXECUTOR_ERROR' });
  let parsed;
  try { parsed = JSON.parse(String(child.stdout || '{}')); }
  catch { throw new Error('Executor sync helper returned invalid JSON'); }
  return parsed;
}

export async function killExecutorIdentity(uid) {
  if (!executorAvailable()) return 0;
  try {
    const result = await requestExecutor('/kill', { uid }, { timeoutMs: 5_000 });
    return Number(result?.killed) || 0;
  } catch {
    return 0;
  }
}

export async function probeExecutor() {
  if (!executorAvailable()) return { ok: false, reason: 'socket_missing' };
  try { return await requestExecutor('/health', {}, { timeoutMs: 2_000 }); }
  catch (error) { return { ok: false, reason: error?.message || String(error) }; }
}
