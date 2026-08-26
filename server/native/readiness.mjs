import fs from 'node:fs';
import path from 'node:path';
import { auditKeyReadinessCheck } from './audit.mjs';
import { probeBrowserService } from './browser-client.mjs';
import { DATA_DIR, WORKSPACES_DIR } from './config.mjs';
import { executorRequired, probeExecutor } from './executor-client.mjs';
import { secretStoreReadinessCheck } from './secrets.mjs';
import { storeReadinessCheck } from './store.mjs';

let cached = null;
let cachedAt = 0;
const CACHE_MS = 2_000;
const MIN_FREE_BYTES = Math.min(Math.max(Number(process.env.Z_AGENT_MIN_FREE_BYTES) || 256 * 1024 * 1024, 16 * 1024 * 1024), 100 * 1024 * 1024 * 1024);

function writableDirectory(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.readiness-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    fs.writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 });
    fs.unlinkSync(probe);
    const statfs = fs.statfsSync(dir);
    const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < MIN_FREE_BYTES) {
      throw new Error(`${label} free space is below the readiness floor (${Math.max(0, Math.floor(freeBytes))} < ${MIN_FREE_BYTES} bytes)`);
    }
    return { ok: true, freeBytes };
  } catch (error) {
    try { fs.unlinkSync(probe); } catch {}
    throw new Error(`${label} is not writable: ${error?.message || error}`);
  }
}

export async function readinessCheck({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_MS) return cached;
  const checks = {};
  const failures = [];
  const run = async (name, fn) => {
    const started = Date.now();
    try {
      const value = await fn();
      checks[name] = { ok: true, latencyMs: Date.now() - started, ...(value && typeof value === 'object' ? value : {}) };
    } catch (error) {
      const message = error?.message || String(error);
      checks[name] = { ok: false, latencyMs: Date.now() - started, error: message };
      failures.push(`${name}: ${message}`);
    }
  };

  await run('database', () => storeReadinessCheck());
  await run('secretStore', () => secretStoreReadinessCheck());
  await run('auditKey', () => auditKeyReadinessCheck());
  await run('dataVolume', () => writableDirectory(DATA_DIR, 'data volume'));
  await run('workspaceVolume', () => writableDirectory(WORKSPACES_DIR, 'workspace volume'));
  await run('executor', async () => {
    const probe = await probeExecutor();
    if (!probe?.ok) {
      if (!executorRequired()) return { ok: true, optional: true, reason: probe?.reason || 'not configured' };
      throw new Error(probe?.reason || 'secure executor unavailable');
    }
    return { ok: true, boundary: probe.networkBoundary || 'unix-socket' };
  });
  await run('browserService', async () => {
    const probe = await probeBrowserService();
    if (!probe?.ok) {
      if (process.env.Z_AGENT_BROWSER_REQUIRED !== '1') return { ok: true, optional: true, reason: probe?.reason || 'not configured' };
      throw new Error(probe?.reason || 'isolated browser service unavailable');
    }
    return { ok: true, isolated: Boolean(probe.isolated) };
  });

  cached = { ok: failures.length === 0, status: failures.length ? 'not_ready' : 'ready', checks, failures, at: now };
  cachedAt = now;
  return cached;
}
