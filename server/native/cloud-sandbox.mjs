// Daytona cloud sandbox: run heavy commands on a remote machine against a
// synced copy of the session workspace. Talks to the public REST API directly
// (no SDK: it pulls AWS/OpenTelemetry into the runtime image).
//
// Sync model per call:
//   1. upload local files changed since the last sync (tar.gz), delete removed
//   2. snapshot the remote tree, run the command, snapshot again
//   3. download remote changes (tar.gz) and apply them to the workspace
// The downloaded archive comes from model-controlled code, so it is extracted
// into a private temp dir only after verifying it holds nothing but regular
// files and directories, and every file is written back through
// safeWorkspacePath with symlinks refused.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeWorkspacePath } from './security.mjs';

const API_URL = () => String(process.env.DAYTONA_API_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');
const API_KEY = () => String(process.env.DAYTONA_API_KEY || '').trim();
export const REMOTE_ROOT = '/home/daytona/workspace';
export const SYNC_EXCLUDES = ['node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.next', '.cache', '.pnpm-store', '.m2', '.agent-home', '.turbo'];
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_SYNC_BYTES = 400 * 1024 * 1024;
const MAX_OUTPUT = 60_000;

export function cloudSandboxConfigured() {
  return Boolean(API_KEY());
}

function defaults() {
  const n = (v, d, lo, hi) => Math.min(Math.max(Number(v) || d, lo), hi);
  return {
    cpu: n(process.env.DAYTONA_CPU, 4, 1, 10),
    memory: n(process.env.DAYTONA_MEMORY_GB, 8, 1, 10),
    disk: n(process.env.DAYTONA_DISK_GB, 10, 1, 30),
    autoStop: n(process.env.DAYTONA_AUTOSTOP_MIN, 15, 1, 1440),
  };
}

const sessions = new Map(); // sessionId -> { id, toolbox, synced: Map, remoteReady }

async function api(method, pathname, { body, base, raw = false, timeoutMs = 60_000, signal, headers = {} } = {}) {
  const url = `${base || API_URL()}${pathname}`;
  const t = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY()}`,
      'x-daytona-source': 'z-agent-native',
      ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
    signal: signal ? AbortSignal.any([signal, t]) : t,
  });
  if (raw) {
    if (!res.ok) throw new Error(`Daytona ${method} ${pathname}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Daytona ${method} ${pathname}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : {}; } catch { return { text }; }
}

// Daytona refuses explicit resources together with a snapshot. Requests that
// fit a stock size use the prebuilt snapshot (instant start); larger ones are
// built once from the same base image with explicit resources.
export const SNAPSHOT_SIZES = [
  { snapshot: 'daytona-small', cpu: 1, memory: 1 },
  { snapshot: 'daytona-medium', cpu: 2, memory: 4 },
  { snapshot: 'daytona-large', cpu: 4, memory: 8 },
];
const BASE_IMAGE = () => String(process.env.DAYTONA_BASE_IMAGE || 'daytonaio/sandbox:0.9.0');

export function sandboxShape(cpu, memory, disk) {
  const fit = SNAPSHOT_SIZES.find((s) => cpu <= s.cpu && memory <= s.memory);
  if (fit) return { snapshot: fit.snapshot };
  return { cpu, memory, disk, buildInfo: { dockerfileContent: `FROM ${BASE_IMAGE()}\n` } };
}

function sandboxName(sessionId) {
  return `zagent-${crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)}`;
}

async function waitStarted(id, signal, timeoutMs = 900_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const sb = await api('GET', `/sandbox/${id}`, { signal });
    if (!sb) throw new Error('Daytona sandbox disappeared');
    if (sb.state === 'started') return sb;
    // pending_build / building_snapshot / creating / starting: keep waiting
    if (['error', 'build_failed', 'destroyed'].includes(sb.state)) throw new Error(`Daytona sandbox state: ${sb.state} ${sb.errorReason || ''}`.trim());
    if (['stopped', 'archived'].includes(sb.state)) await api('POST', `/sandbox/${id}/start`, { signal, timeoutMs: 120_000 });
    if (Date.now() > until) throw new Error(`Daytona sandbox did not start in time (state ${sb.state})`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function ensureSandbox(sessionId, opts, signal) {
  let entry = sessions.get(sessionId);
  const name = sandboxName(sessionId);
  let sb = await api('GET', `/sandbox/${entry?.id || name}`, { signal });
  if (!sb) {
    const d = defaults();
    const cpu = Math.min(Math.max(Number(opts.cpu) || d.cpu, 1), 10);
    const memory = Math.min(Math.max(Number(opts.memory) || d.memory, 1), 10);
    sb = await api('POST', '/sandbox', {
      signal,
      timeoutMs: 600_000,
      body: {
        name,
        labels: { 'z-agent-session': String(sessionId).slice(0, 63) },
        ...sandboxShape(cpu, memory, d.disk),
        autoStopInterval: d.autoStop,
        autoArchiveInterval: 60 * 24,
        autoDeleteInterval: 60 * 24 * 3,
      },
    });
    entry = null;
  }
  sb = await waitStarted(sb.id, signal);
  let toolbox = sb.toolboxProxyUrl;
  if (!toolbox) toolbox = (await api('GET', `/sandbox/${sb.id}/toolbox-proxy-url`, { signal }))?.url;
  if (!toolbox) throw new Error('Daytona did not return a toolbox URL');
  const base = `${String(toolbox).replace(/\/+$/, '')}/${sb.id}`;
  if (!entry || entry.id !== sb.id) entry = { id: sb.id, synced: new Map(), remoteReady: false };
  entry.base = base;
  entry.cpu = sb.cpu; entry.memory = sb.memory; entry.disk = sb.disk;
  sessions.set(sessionId, entry);
  return entry;
}

async function exec(entry, command, { timeoutSec = 120, signal } = {}) {
  // The toolbox chdirs before spawning, and a missing cwd surfaces as a
  // misleading "fork/exec /usr/bin/zsh: no such file". Start from / and
  // create the workspace inside the command instead.
  const script = `mkdir -p ${REMOTE_ROOT} && cd ${REMOTE_ROOT} && ${command}`;
  const r = await api('POST', '/process/execute', {
    base: entry.base, signal,
    timeoutMs: (timeoutSec + 30) * 1000,
    body: { command: `bash -lc ${shq(script)}`, cwd: '/', timeout: timeoutSec },
  });
  return { code: Number(r?.exitCode ?? r?.code ?? 1), output: String(r?.result ?? '') };
}

export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function localManifest(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (SYNC_EXCLUDES.includes(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full, r);
      else if (d.isFile()) {
        try { const st = fs.statSync(full); out.set(r, `${st.size}:${Math.floor(st.mtimeMs)}`); } catch {}
      }
    }
  };
  walk(root, '');
  return out;
}

export function parseRemoteManifest(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const [p, size, mtime] = line.split('\t');
    if (!p || size === undefined) continue;
    out.set(p.replace(/^\.\//, ''), `${size}:${Math.floor(Number(mtime) || 0)}`);
  }
  return out;
}

export function diffManifests(before, after) {
  const changed = [];
  const removed = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) changed.push(p);
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { changed, removed };
}

function remoteManifestCommand() {
  const prune = SYNC_EXCLUDES.map((n) => `-name ${shq(n)}`).join(' -o ');
  return `mkdir -p ${REMOTE_ROOT} && cd ${REMOTE_ROOT} && find . \\( ${prune} \\) -prune -o -type f -printf '%P\\t%s\\t%T@\\n'`;
}

async function remoteManifest(entry, signal) {
  const r = await exec(entry, remoteManifestCommand(), { timeoutSec: 120, signal });
  if (r.code !== 0) throw new Error(`remote manifest failed: ${r.output.slice(0, 300)}`);
  return parseRemoteManifest(r.output);
}

function tarLocal(root, files) {
  const list = path.join(os.tmpdir(), `zcs-${crypto.randomUUID()}.lst`);
  fs.writeFileSync(list, files.join('\n') + '\n');
  try {
    const r = spawnSync('tar', ['-czf', '-', '-C', root, '--no-recursion', '-T', list], { maxBuffer: MAX_SYNC_BYTES + 1024 * 1024 });
    if (r.status !== 0) throw new Error(`tar failed: ${String(r.stderr || '').slice(0, 300)}`);
    return r.stdout;
  } finally { fs.rmSync(list, { force: true }); }
}

/** Only regular files and directories, no absolute or parent-relative names. */
export function verifyTarListing(listing) {
  for (const line of String(listing || '').split('\n')) {
    if (!line.trim()) continue;
    if (!/^[-d]/.test(line)) throw new Error(`refusing archive entry: ${line.slice(0, 120)}`);
  }
}

function applyRemoteArchive(root, buf, removed, owner) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcs-in-'));
  try {
    const tgz = path.join(tmp, 'in.tgz');
    fs.writeFileSync(tgz, buf);
    const ls = spawnSync('tar', ['-tvzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (ls.status !== 0) throw new Error('downloaded archive is not a valid tar.gz');
    verifyTarListing(ls.stdout);
    const dest = path.join(tmp, 'x');
    fs.mkdirSync(dest);
    const x = spawnSync('tar', ['-xzf', tgz, '-C', dest, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8' });
    if (x.status !== 0) throw new Error(`extract failed: ${String(x.stderr).slice(0, 300)}`);
    let written = 0;
    const walk = (dir, rel) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        const src = path.join(dir, d.name);
        if (d.isDirectory()) { walk(src, r); continue; }
        if (!d.isFile()) continue;
        const target = safeWorkspacePath(root, r);
        assertNoSymlinkOnPath(root, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        const mode = fs.statSync(src).mode & 0o755;
        try { fs.chmodSync(target, mode | 0o600); } catch {}
        owner?.(target);
        written++;
      }
    };
    walk(dest, '');
    let deleted = 0;
    for (const r of removed) {
      try {
        const target = safeWorkspacePath(root, r);
        assertNoSymlinkOnPath(root, target);
        const st = fs.lstatSync(target);
        if (st.isFile()) { fs.rmSync(target); deleted++; }
      } catch {}
    }
    return { written, deleted };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function assertNoSymlinkOnPath(root, target) {
  const base = path.resolve(root);
  let cur = path.resolve(target);
  while (cur !== base && cur.startsWith(base + path.sep)) {
    try { if (fs.lstatSync(cur).isSymbolicLink()) throw new Error(`refusing to write through symlink: ${path.relative(base, cur)}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    cur = path.dirname(cur);
  }
}

async function pushLocal(root, entry, signal) {
  const local = localManifest(root);
  const { changed, removed } = diffManifests(entry.synced, local);
  let bytes = 0;
  const upload = [];
  const skipped = [];
  for (const p of changed) {
    const size = Number(local.get(p).split(':')[0]);
    if (size > MAX_FILE_BYTES || bytes + size > MAX_SYNC_BYTES) { skipped.push(p); continue; }
    bytes += size;
    upload.push(p);
  }
  if (upload.length) {
    const tgz = tarLocal(root, upload);
    const form = new FormData();
    form.append('file', new Blob([tgz]), 'sync.tgz');
    const remoteTgz = `/tmp/zcs-up-${crypto.randomUUID()}.tgz`;
    await api('POST', `/files/upload-v2?path=${encodeURIComponent(remoteTgz)}`, { base: entry.base, body: form, signal, timeoutMs: 600_000 });
    const r = await exec(entry, `mkdir -p ${REMOTE_ROOT} && tar -xzf ${remoteTgz} -C ${REMOTE_ROOT} && rm -f ${remoteTgz}`, { timeoutSec: 600, signal });
    if (r.code !== 0) throw new Error(`remote extract failed: ${r.output.slice(0, 300)}`);
  }
  if (removed.length && entry.remoteReady) {
    const r = await exec(entry, `cd ${REMOTE_ROOT} && rm -f -- ${removed.map(shq).join(' ')}`, { timeoutSec: 120, signal });
    if (r.code !== 0) throw new Error(`remote delete failed: ${r.output.slice(0, 300)}`);
  }
  entry.remoteReady = true;
  return { uploaded: upload.length, removed: removed.length, skipped, local };
}

async function pullRemote(root, entry, before, signal, owner) {
  const after = await remoteManifest(entry, signal);
  const { changed, removed } = diffManifests(before, after);
  const take = [];
  const skipped = [];
  let bytes = 0;
  for (const p of changed) {
    const size = Number(after.get(p).split(':')[0]);
    if (size > MAX_FILE_BYTES || bytes + size > MAX_SYNC_BYTES) { skipped.push(p); continue; }
    bytes += size;
    take.push(p);
  }
  let result = { written: 0, deleted: 0 };
  if (take.length || removed.length) {
    let buf = Buffer.alloc(0);
    if (take.length) {
      const listPath = `/tmp/zcs-dl-${crypto.randomUUID()}`;
      const form = new FormData();
      form.append('file', new Blob([take.join('\n') + '\n']), 'list');
      await api('POST', `/files/upload-v2?path=${encodeURIComponent(`${listPath}.lst`)}`, { base: entry.base, body: form, signal });
      const r = await exec(entry, `cd ${REMOTE_ROOT} && tar -czf ${listPath}.tgz --no-recursion -T ${listPath}.lst`, { timeoutSec: 600, signal });
      if (r.code !== 0) throw new Error(`remote archive failed: ${r.output.slice(0, 300)}`);
      buf = await api('GET', `/files/download?path=${encodeURIComponent(`${listPath}.tgz`)}`, { base: entry.base, raw: true, signal, timeoutMs: 600_000 });
      await exec(entry, `rm -f ${listPath}.lst ${listPath}.tgz`, { timeoutSec: 30, signal }).catch(() => {});
    }
    result = take.length
      ? applyRemoteArchive(root, buf, removed, owner)
      : applyRemoteArchive(root, emptyTgz(), removed, owner);
  }
  return { ...result, skipped, changedPaths: [...take, ...removed] };
}

function emptyTgz() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcs-e-'));
  try { return spawnSync('tar', ['-czf', '-', '-C', dir, '--files-from', '/dev/null']).stdout; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function clip(text) {
  const s = String(text || '');
  return s.length > MAX_OUTPUT ? `${s.slice(0, 20_000)}\n…[${s.length - MAX_OUTPUT} chars truncated]…\n${s.slice(-40_000)}` : s;
}

export async function executeCloudSandbox(root, input = {}, ctx = {}) {
  if (!cloudSandboxConfigured()) throw new Error('Cloud sandbox is not configured (DAYTONA_API_KEY is empty)');
  if (!ctx.sessionId) throw new Error('cloud_sandbox requires a chat session');
  const action = String(input.action || 'run').toLowerCase();
  const signal = ctx.signal;

  if (action === 'destroy') {
    const entry = sessions.get(ctx.sessionId);
    const id = entry?.id || sandboxName(ctx.sessionId);
    const sb = await api('GET', `/sandbox/${id}`, { signal });
    if (sb) await api('DELETE', `/sandbox/${sb.id}`, { signal });
    sessions.delete(ctx.sessionId);
    return { output: sb ? 'Cloud sandbox deleted.' : 'No cloud sandbox for this chat.', title: 'Cloud sandbox: destroy' };
  }

  if (action === 'status') {
    const entry = sessions.get(ctx.sessionId);
    const sb = await api('GET', `/sandbox/${entry?.id || sandboxName(ctx.sessionId)}`, { signal });
    if (!sb) return { output: 'No cloud sandbox for this chat yet. It is created on the first run.', title: 'Cloud sandbox: status' };
    return {
      output: `state=${sb.state} cpu=${sb.cpu} memoryGB=${sb.memory} diskGB=${sb.disk} autoStopMin=${sb.autoStopInterval}`,
      title: 'Cloud sandbox: status',
    };
  }

  if (action !== 'run') throw new Error(`Unknown cloud_sandbox action: ${action}`);
  const command = String(input.command || '').trim();
  if (!command) throw new Error('command must not be empty');
  const timeoutSec = Math.min(Math.max(Number(input.timeoutSec) || 600, 10), 3600);

  const entry = await ensureSandbox(ctx.sessionId, input, signal);
  const push = await pushLocal(root, entry, signal);
  const before = await remoteManifest(entry, signal);
  const started = Date.now();
  const run = await exec(entry, command, { timeoutSec, signal });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const pull = await pullRemote(root, entry, before, signal, ctx.chownToSession);
  entry.synced = localManifest(root);

  const notes = [];
  if (push.uploaded || push.removed) notes.push(`synced up: ${push.uploaded} file(s), ${push.removed} deletion(s)`);
  if (pull.written || pull.deleted) notes.push(`synced back: ${pull.written} file(s), ${pull.deleted} deletion(s)`);
  const skipped = [...push.skipped, ...pull.skipped];
  if (skipped.length) notes.push(`not synced (too large): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ' …' : ''}`);
  notes.push(`not synced by design: ${SYNC_EXCLUDES.join(', ')}`);
  return {
    output: `exit=${run.code}\noutput:\n${clip(run.output)}\n\n[exit ${run.code} · ${seconds}s · ${entry.cpu} vCPU / ${entry.memory} GB · ${notes.join(' · ')}]`,
    title: `Cloud sandbox: ${command.slice(0, 80)}`,
    metadata: { exit: run.code, cloudSandbox: { exitCode: run.code, seconds: Number(seconds), uploaded: push.uploaded, downloaded: pull.written, deleted: pull.deleted } },
    mutatedPaths: pull.changedPaths,
  };
}

/** Удалить облачную машину чата (при удалении чата). Без ключа — ничего. */
export async function destroyCloudSandboxForSession(sessionId) {
  if (!cloudSandboxConfigured() || !sessionId) return false;
  const entry = sessions.get(sessionId);
  const sb = await api('GET', `/sandbox/${entry?.id || sandboxName(sessionId)}`, { timeoutMs: 15_000 });
  sessions.delete(sessionId);
  if (!sb) return false;
  await api('DELETE', `/sandbox/${sb.id}`, { timeoutMs: 30_000 });
  return true;
}
