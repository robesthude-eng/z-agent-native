import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SOCKET_PATH = process.env.Z_AGENT_EXECUTOR_SOCKET || '/run/z-agent-executor/executor.sock';
const WORKSPACES_DIR = path.resolve(process.env.Z_AGENT_WORKSPACES_DIR || '/workspaces');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const PRLIMIT = ['/usr/bin/prlimit', '/bin/prlimit'].find((candidate) => fs.existsSync(candidate)) || null;
const SETPRIV = ['/usr/bin/setpriv', '/bin/setpriv', '/sbin/setpriv'].find((candidate) => fs.existsSync(candidate)) || null;
const ENV = ['/usr/bin/env', '/bin/env'].find((candidate) => fs.existsSync(candidate)) || null;
if (!PRLIMIT || !SETPRIV || !ENV) throw new Error('Secure executor requires util-linux setpriv/prlimit and env');
const LIMIT_NPROC = Math.min(Math.max(Number(process.env.Z_AGENT_EXECUTOR_NPROC) || 256, 32), 1024);
const LIMIT_NOFILE = Math.min(Math.max(Number(process.env.Z_AGENT_EXECUTOR_NOFILE) || 2048, 256), 8192);
const LIMIT_FILE_BYTES = Math.min(Math.max(Number(process.env.Z_AGENT_EXECUTOR_FILE_BYTES) || 512 * 1024 * 1024, 16 * 1024 * 1024), 2 * 1024 * 1024 * 1024);
const EXPECT_NETWORK_NONE = process.env.Z_AGENT_EXECUTOR_EXPECT_NETWORK_NONE === '1';
const MAX_ACTIVE_GLOBAL = Math.min(Math.max(Number(process.env.Z_AGENT_EXECUTOR_MAX_ACTIVE) || 8, 1), 64);
const MAX_ACTIVE_PER_UID = Math.min(Math.max(Number(process.env.Z_AGENT_EXECUTOR_MAX_ACTIVE_PER_UID) || 2, 1), 8);
const activeByUid = new Map();


function trustedLauncherEnvironment() {
  // Never pass tool-controlled variables to a privileged dynamic executable.
  // LD_PRELOAD/NODE_OPTIONS-style values are only applied after setpriv has
  // irreversibly dropped uid/gid and no-new-privs is active.
  return {
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}

function normalizeChildEnvironment(input) {
  const out = [];
  for (const [rawKey, rawValue] of Object.entries(input || {}).slice(0, 256)) {
    const key = String(rawKey);
    const value = String(rawValue);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      throw Object.assign(new Error(`Invalid environment key ${JSON.stringify(key)}`), { statusCode: 400 });
    }
    if (value.includes('\0') || value.length > 32 * 1024) {
      throw Object.assign(new Error(`Invalid environment value for ${key}`), { statusCode: 400 });
    }
    out.push(`${key}=${value}`);
  }
  return out;
}

function activeCount() {
  let total = 0;
  for (const set of activeByUid.values()) total += set.size;
  return total;
}

function networkBoundaryStatus() {
  const external = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (!address || address.internal || address.address === '127.0.0.1' || address.address === '::1') continue;
      external.push({ name, family: address.family, address: address.address });
    }
  }
  return { ok: !EXPECT_NETWORK_NONE || external.length === 0, expectedNone: EXPECT_NETWORK_NONE, externalInterfaces: external };
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(data.length), 'cache-control': 'no-store' });
  res.end(data);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Executor request too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}

function workspacePath(raw) {
  const full = path.resolve(String(raw || ''));
  if (full === WORKSPACES_DIR || !full.startsWith(`${WORKSPACES_DIR}${path.sep}`)) {
    throw Object.assign(new Error('Workspace outside executor root'), { statusCode: 403 });
  }
  const stat = fs.statSync(full);
  if (!stat.isDirectory()) throw Object.assign(new Error('Workspace is not a directory'), { statusCode: 400 });
  return full;
}

function identity(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 20000 || n > 2_000_000_000) throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400 });
  return n;
}

function safeFile(raw) {
  const file = String(raw || '');
  if (!file || file.includes('\0')) throw Object.assign(new Error('Invalid executable'), { statusCode: 400 });
  // The executor is intentionally a general code runner. Its hard boundaries
  // are the container filesystem, Unix identity, resource limits and Docker's
  // network_mode:none — not a fragile executable allowlist.
  return file;
}

function track(uid, child) {
  const set = activeByUid.get(uid) || new Set();
  set.add(child);
  activeByUid.set(uid, set);
  child.once('close', () => {
    set.delete(child);
    if (!set.size) activeByUid.delete(uid);
  });
}

function killChild(child, signal = 'SIGTERM') {
  try { process.kill(-child.pid, signal); return true; }
  catch { try { child.kill(signal); return true; } catch { return false; } }
}

async function execRequest(req, res, input) {
  const workspace = workspacePath(input.workspace);
  const uid = identity(input.uid, 'uid');
  const gid = identity(input.gid ?? input.uid, 'gid');
  const owner = fs.statSync(workspace);
  if (owner.uid !== uid || owner.gid !== gid) {
    throw Object.assign(new Error('Workspace ownership does not match executor identity'), { statusCode: 403, code: 'EXECUTOR_IDENTITY_MISMATCH' });
  }
  const file = safeFile(input.file);
  const args = Array.isArray(input.args) ? input.args.map((value) => String(value)).slice(0, 256) : [];
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 600_000, 1000), 1_800_000);
  const envInput = input.env && typeof input.env === 'object' && !Array.isArray(input.env) ? input.env : {};
  const envAssignments = normalizeChildEnvironment(envInput);
  const uidActive = activeByUid.get(uid)?.size || 0;
  if (activeCount() >= MAX_ACTIVE_GLOBAL || uidActive >= MAX_ACTIVE_PER_UID) {
    throw Object.assign(new Error('Executor concurrency limit reached'), { statusCode: 429, code: 'EXECUTOR_BUSY' });
  }

  // Per-command limits prevent one session from consuming the entire shared
  // executor service. Docker caps remain the outer host boundary; these rlimits
  // are inherited by every descendant of the tool command.
  // Node's spawn({uid,gid}) does not express the critical "clear all
  // supplementary groups" invariant. Launch through setpriv so a session can
  // never inherit root's supplementary groups and use them to reach the
  // executor socket or other privileged group-owned resources. prlimit then
  // applies resource caps after privileges have been irreversibly dropped.
  const launchFile = SETPRIV;
  const launchArgs = [
    '--clear-groups', '--no-new-privs', `--reuid=${uid}`, `--regid=${gid}`,
    PRLIMIT,
    `--nproc=${LIMIT_NPROC}:${LIMIT_NPROC}`,
    `--nofile=${LIMIT_NOFILE}:${LIMIT_NOFILE}`,
    `--fsize=${LIMIT_FILE_BYTES}:${LIMIT_FILE_BYTES}`,
    '--core=0:0', '--', ENV, '-i', '--', ...envAssignments, file, ...args,
  ];
  const child = spawn(launchFile, launchArgs, {
    cwd: workspace,
    env: trustedLauncherEnvironment(),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  track(uid, child);

  let stdout = '';
  let stderr = '';
  const append = (current, chunk) => {
    const next = current + Buffer.from(chunk).toString('utf8');
    return next.length > MAX_OUTPUT ? `[truncated]\n${next.slice(-MAX_OUTPUT)}` : next;
  };
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
  if (input.stdin) child.stdin.end(String(input.stdin)); else child.stdin.end();

  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    killChild(child, 'SIGTERM');
    setTimeout(() => killChild(child, 'SIGKILL'), 1000).unref?.();
  };
  const timer = setTimeout(terminate, timeoutMs);
  timer.unref?.();
  const disconnected = () => terminate();
  req.once('aborted', disconnected);
  req.once('close', () => { if (!res.writableEnded) disconnected(); });

  child.once('error', (error) => {
    clearTimeout(timer);
    if (!res.writableEnded) json(res, 500, { error: error?.message || String(error), code: 'SPAWN_FAILED' });
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (!res.writableEnded) json(res, 200, { code: code ?? (signal ? 130 : 1), signal: signal || null, stdout, stderr });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    const input = await body(req);
    if (req.url === '/health') {
      const network = networkBoundaryStatus();
      return json(res, network.ok ? 200 : 503, {
        ok: network.ok, pid: process.pid, networkBoundary: network.ok && network.expectedNone ? 'verified-loopback-only' : (network.expectedNone ? 'network-interface-leak' : 'not-attested'),
        network, privilegeDrop: 'setpriv-clear-groups-no-new-privs', privilegedEnv: 'fixed-before-drop',
        concurrency: { active: activeCount(), maxActive: MAX_ACTIVE_GLOBAL, maxPerUid: MAX_ACTIVE_PER_UID },
        rlimits: { nproc: LIMIT_NPROC, nofile: LIMIT_NOFILE, fileBytes: LIMIT_FILE_BYTES, enforced: true },
      });
    }
    if (req.url === '/kill') {
      const uid = identity(input.uid, 'uid');
      let killed = 0;
      for (const child of activeByUid.get(uid) || []) if (killChild(child, 'SIGTERM')) killed += 1;
      return json(res, 200, { ok: true, killed });
    }
    if (req.url === '/exec') return await execRequest(req, res, input);
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, Number(error?.statusCode) || 500, { error: error?.message || String(error), code: error?.code || 'EXECUTOR_ERROR' });
  }
});

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
try { fs.unlinkSync(SOCKET_PATH); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
server.listen(SOCKET_PATH, () => {
  fs.chmodSync(path.dirname(SOCKET_PATH), 0o700);
  fs.chmodSync(SOCKET_PATH, 0o660);
  console.log(`[executor] listening on ${SOCKET_PATH}; network must be disabled by container runtime`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const set of activeByUid.values()) for (const child of set) killChild(child, 'SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref?.();
  });
}

// The container restarts this process, but a crash that leaves no structured
// trace is undiagnosable afterwards, and the sandboxed children would outlive
// the parent that is supposed to reap them. The shape matches the API server's
// fatal record so one log query covers every process in the deployment.
function fatal(kind, cause) {
  try {
    console.error(JSON.stringify({
      level: 'fatal',
      service: 'executor',
      event: kind,
      at: new Date().toISOString(),
      activeUids: activeByUid.size,
      message: String(cause?.message || cause),
      stack: typeof cause?.stack === 'string' ? cause.stack.slice(0, 4000) : undefined,
    }));
  } catch {
    console.error('[executor]', kind, cause);
  }
  // Exiting non-zero has to survive the event loop draining on its own, so the
  // code is set up front and the timer only forces the issue if a handle hangs.
  process.exitCode = 1;
  try { for (const set of activeByUid.values()) for (const child of set) killChild(child, 'SIGKILL'); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(1), 250).unref?.();
}
process.on('unhandledRejection', (reason) => { fatal('unhandledRejection', reason); });
process.on('uncaughtException', (error) => { fatal('uncaughtException', error); });
