import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOW_UNISOLATED_SHELL, DATA_DIR, WORKSPACES_DIR } from './config.mjs';
import { getSandboxUid } from './store.mjs';

// Sessions already normalised in this process. The initial ownership pass walks
// every file in the workspace, so repeating it on every shell spawn blocked the
// event loop for all other sessions.
const preparedSandboxes = new Set();

const SETPRIV_PATH = ['/usr/bin/setpriv', '/bin/setpriv', '/sbin/setpriv']
  .find((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } }) || null;

function isRootRuntime() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

let rootSandboxProbe = null;
function rootSandboxAvailable() {
  if (!isRootRuntime() || !SETPRIV_PATH) return false;
  if (rootSandboxProbe !== null) return rootSandboxProbe;
  try {
    const probe = spawnSync(SETPRIV_PATH, [
      '--clear-groups', '--no-new-privs', '--reuid=20000', '--regid=20000',
      '/bin/true',
    ], { stdio: 'ignore', timeout: 2000 });
    rootSandboxProbe = probe.status === 0;
  } catch {
    rootSandboxProbe = false;
  }
  return rootSandboxProbe;
}

// Read the environment as well as the cached config constant so a test (or an
// operator using a process manager that injects late) can still flip the flag.
function unisolatedShellRequested() {
  return ALLOW_UNISOLATED_SHELL || process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL === '1';
}

// The development fallback runs the agent's shell as the server user. When the
// server user is root that is not "weaker isolation", it is none at all: the
// model gets read/write access to data/master.key, the SQLite database and
// every other session's workspace, plus the ability to re-enter the container's
// capability set. Refuse that combination unless the operator opts in a second
// time, so copying Z_AGENT_ALLOW_UNISOLATED_SHELL=1 out of a laptop .env into
// the container cannot silently disable the sandbox.
function unisolatedShellAllowed() {
  if (!unisolatedShellRequested()) return false;
  if (!isRootRuntime()) return true;
  return process.env.Z_AGENT_ALLOW_ROOT_SHELL === '1';
}

export function shellSandboxAvailable() {
  return rootSandboxAvailable() || unisolatedShellAllowed();
}

export function sandboxIdentity(sessionId) {
  if (rootSandboxAvailable()) {
    const uid = getSandboxUid(sessionId);
    if (!Number.isInteger(uid) || uid < 20000 || uid > 2_000_000_000) throw new Error(`No sandbox identity for session ${sessionId}`);
    return { uid, gid: uid, isolated: true };
  }
  if (unisolatedShellAllowed()) return { isolated: false };
  if (isRootRuntime() && unisolatedShellRequested()) {
    throw new Error('Refusing to run the agent shell as root: setpriv-based isolation is unavailable and Z_AGENT_ALLOW_UNISOLATED_SHELL only covers non-root runtimes. Install util-linux (setpriv) in the image, run the server as a non-root user, or set Z_AGENT_ALLOW_ROOT_SHELL=1 to knowingly accept full host access for this process.');
  }
  throw new Error('Shell sandbox is unavailable. Run Z Agent in Docker, or explicitly set Z_AGENT_ALLOW_UNISOLATED_SHELL=1 for an unsafe single-user development fallback.');
}

function chownTree(full, uid, gid) {
  let st;
  try { st = fs.lstatSync(full); } catch { return; }
  if (st.uid !== uid || st.gid !== gid) { try { fs.lchownSync(full, uid, gid); } catch {} }
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  let names;
  try { names = fs.readdirSync(full); } catch { return; }
  for (const name of names) chownTree(path.join(full, name), uid, gid);
}

/**
 * Build the argv that starts a process under the session identity.
 *
 * spawn({uid,gid}) keeps the parent's supplementary groups (root's), so prefer
 * setpriv: it clears them and blocks privilege regain through no-new-privs.
 */
export function sandboxCommand(identity, file, args = []) {
  if (!identity?.isolated) return { file, args, options: {} };
  if (!SETPRIV_PATH) throw new Error('Secure setpriv launcher is unavailable');
  return {
    file: SETPRIV_PATH,
    args: ['--clear-groups', '--no-new-privs', `--reuid=${identity.uid}`, `--regid=${identity.gid}`, file, ...args],
    options: {},
  };
}

export function prepareWorkspaceSandbox(sessionId, workspace) {
  const identity = sandboxIdentity(sessionId);
  if (!identity.isolated) return identity;
  const root = path.resolve(workspace);
  const parent = path.resolve(WORKSPACES_DIR);
  if (root !== parent && !root.startsWith(`${parent}${path.sep}`)) throw new Error('Workspace is outside the configured sandbox root');
  fs.mkdirSync(root, { recursive: true });
  const key = `${sessionId}:${root}:${identity.uid}`;
  if (preparedSandboxes.has(key)) {
    try { fs.lchownSync(root, identity.uid, identity.gid); } catch {}
  } else {
    chownTree(root, identity.uid, identity.gid);
    preparedSandboxes.add(key);
  }
  try { fs.chmodSync(root, 0o700); } catch {}
  return identity;
}

export function resetSandboxCacheForTests() {
  preparedSandboxes.clear();
  rootSandboxProbe = null;
}

export function syncSandboxOwnership(sessionId, workspace, target = workspace) {
  if (!rootSandboxAvailable()) return;
  const identity = sandboxIdentity(sessionId);
  const root = path.resolve(workspace);
  let full = path.resolve(target);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error('Sandbox ownership target escaped workspace');
  if (fs.existsSync(full)) chownTree(full, identity.uid, identity.gid);
  while (full !== root) {
    full = path.dirname(full);
    try { fs.lchownSync(full, identity.uid, identity.gid); } catch {}
  }
  try { fs.lchownSync(root, identity.uid, identity.gid); } catch {}
  try { fs.chmodSync(root, 0o700); } catch {}
}

const MANAGED_HOME_DIRS = ['cache/pip', 'cache/npm', 'venvs', 'bin', '.local/bin'];

/**
 * Session HOME lives at workspace/.agent-home. The API process is root in
 * Docker, so a bare mkdirSync leaves that tree owned by root and the session
 * UID cannot create venvs or pip cache. Always mkdir then chown to the sandbox.
 */
export function ensureManagedHome(sessionId, workspace) {
  const root = path.resolve(workspace);
  const home = path.join(root, '.agent-home');
  fs.mkdirSync(home, { recursive: true });
  for (const dir of MANAGED_HOME_DIRS) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  try { fs.chmodSync(home, 0o700); } catch {}
  if (sessionId) syncSandboxOwnership(sessionId, root, home);
  return home;
}

export function killSandboxProcesses(sessionId) {
  if (!isRootRuntime()) return 0;
  const uid = getSandboxUid(sessionId);
  if (!Number.isInteger(uid)) return 0;
  let killed = 0;
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return 0; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!pid || pid === process.pid) continue;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const realUid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      if (realUid !== uid) continue;
      process.kill(pid, 'SIGTERM');
      killed += 1;
      setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 750).unref?.();
    } catch {}
  }
  return killed;
}

export function assertRuntimeSecretsPrivate() {
  if (!isRootRuntime()) return;
  try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
  try { fs.chmodSync(WORKSPACES_DIR, 0o711); } catch {}
  // Loud, once, at boot: this is the one configuration where the runtime hands
  // the model the same privileges as the server itself.
  if (unisolatedShellRequested() && !rootSandboxAvailable() && process.env.Z_AGENT_ALLOW_ROOT_SHELL === '1') {
    console.warn('[z-agent] SECURITY: agent shell runs as root without setpriv isolation (Z_AGENT_ALLOW_ROOT_SHELL=1). Every session can read data/master.key and all other workspaces.');
  }
}
