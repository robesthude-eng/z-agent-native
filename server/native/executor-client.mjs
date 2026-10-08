import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutorStreamParser } from './executor-stream.mjs';

const SOCKET_PATH = process.env.Z_AGENT_EXECUTOR_SOCKET || '/run/z-agent-executor/executor.sock';
const REQUIRED = process.env.Z_AGENT_EXECUTOR_REQUIRED === '1';
const SYNC_HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../executor-sync-client.mjs');

export function executorSocketPath() {
  return SOCKET_PATH;
}
export function executorRequired() {
  return REQUIRED;
}
export function executorAvailable() {
  try {
    return fs.statSync(SOCKET_PATH).isSocket();
  } catch {
    return false;
  }
}

async function waitForExecutorSocket(timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (executorAvailable()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return executorAvailable();
}

const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EAGAIN']);

function requestExecutor(pathname, payload, { signal, timeoutMs = 10_000, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    let settled = false;
    let accepted = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (fn === reject && accepted && value && typeof value === 'object') value.executorAccepted = true;
      fn(value);
    };
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      },
      (res) => {
        accepted = (res.statusCode || 500) < 400;
        const streaming = accepted && String(res.headers['content-type'] || '').includes('application/x-ndjson');
        const parser = streaming ? createExecutorStreamParser(onOutput) : null;
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          try {
            if (parser) return parser.push(chunk);
            size += chunk.length;
            if (size > 4 * 1024 * 1024) throw new Error('Executor response exceeded 4 MiB');
            chunks.push(chunk);
          } catch (error) {
            finish(reject, error);
            req.destroy(error);
          }
        });
        res.on('error', (error) => finish(reject, error));
        res.on('aborted', () => finish(reject, new Error('Executor response disconnected')));
        res.on('end', () => {
          if (settled) return;
          let parsed;
          try {
            parsed = parser ? parser.finish() : JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch (error) {
            return finish(reject, error);
          }
          if ((res.statusCode || 500) >= 400) {
            const error = new Error(parsed?.error || `Executor HTTP ${res.statusCode}`);
            error.code = parsed?.code || 'EXECUTOR_ERROR';
            return finish(reject, error);
          }
          finish(resolve, parsed);
        });
      },
    );
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

export async function executeInExecutor({ workspace, uid, gid = uid, file, args = [], env = {}, stdin = '', timeoutMs, signal, onOutput }) {
  if (!executorAvailable()) {
    await waitForExecutorSocket(2500);
  }
  if (!executorAvailable()) {
    if (REQUIRED)
      throw Object.assign(new Error(`Secure executor is required but unavailable at ${SOCKET_PATH}`), { code: 'EXECUTOR_UNAVAILABLE' });
    return null;
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
    try {
      return await requestExecutor(
        '/exec',
        {
          workspace,
          uid,
          gid,
          file,
          args,
          env,
          stdin,
          timeoutMs,
          streamOutput: typeof onOutput === 'function',
        },
        { signal, onOutput, timeoutMs: Math.min(Math.max(Number(timeoutMs) || 600_000, 5_000) + 10_000, 1_810_000) },
      );
    } catch (err) {
      lastErr = err;
      // Retry only when the connection itself could not be established. A
      // dropped connection ("socket hang up", ECONNRESET) can happen after the
      // executor already started the command, and re-sending would run a
      // possibly mutating command twice.
      if (!err?.executorAccepted && CONNECT_FAILURE_CODES.has(err?.code)) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function executeInExecutorSync({ workspace, uid, gid = uid, file, args = [], env = {}, stdin = '', timeoutMs }) {
  if (!executorAvailable()) {
    if (REQUIRED)
      throw Object.assign(new Error(`Secure executor is required but unavailable at ${SOCKET_PATH}`), { code: 'EXECUTOR_UNAVAILABLE' });
    return null;
  }
  const budget = Math.min(Math.max(Number(timeoutMs) || 60_000, 1_000), 1_800_000);
  const payload = { workspace, uid, gid, file, args, env, stdin, timeoutMs: budget };
  const child = spawnSync(process.execPath, [SYNC_HELPER], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: budget + 15_000,
    maxBuffer: 5 * 1024 * 1024,
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', Z_AGENT_EXECUTOR_SOCKET: SOCKET_PATH },
  });
  if (child.error) throw child.error;
  if ((child.status ?? 1) !== 0)
    throw Object.assign(new Error(String(child.stderr || child.stdout || `Executor sync helper exited ${child.status}`).trim()), {
      code: 'EXECUTOR_ERROR',
    });
  let parsed;
  try {
    parsed = JSON.parse(String(child.stdout || '{}'));
  } catch {
    throw new Error('Executor sync helper returned invalid JSON');
  }
  return parsed;
}

export async function killExecutorIdentity(uid, { purge = false } = {}) {
  if (!executorAvailable()) return 0;
  try {
    const result = await requestExecutor('/kill', purge ? { uid, purge: true } : { uid }, { timeoutMs: 15_000 });
    return Number(result?.killed) || 0;
  } catch {
    return 0;
  }
}

// Последнее, что executor сам сообщил о своей сети. Описание среды для модели
// берёт это значение, а не переменную окружения: настройка сети задаётся
// контейнеру executor, и основной сервис может о ней не знать.
let lastNetworkAttestation = null;

/** true — у executor нет внешних интерфейсов, false — есть, null — неизвестно. */
export function executorNetworkless() {
  return lastNetworkAttestation;
}

export async function probeExecutor() {
  if (!executorAvailable()) {
    await waitForExecutorSocket(1500);
  }
  if (!executorAvailable()) return { ok: false, reason: 'socket_missing' };
  try {
    const result = await requestExecutor('/health', {}, { timeoutMs: 2_000 });
    const external = result?.network?.externalInterfaces;
    if (Array.isArray(external)) lastNetworkAttestation = external.length === 0;
    return result;
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}
