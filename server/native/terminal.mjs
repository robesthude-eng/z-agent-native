import { spawn } from 'node:child_process';
import { authFromRequest } from './auth.mjs';
import { ALLOWED_ORIGINS } from './config.mjs';
import { isSessionId } from './security.mjs';
import { managedShellEnvironment } from './environment.mjs';
import { ownsChat, workspaceFor } from './store.mjs';
import { ensureManagedHome, prepareWorkspaceSandbox, sandboxCommand, shellSandboxAvailable } from './sandbox.mjs';
import { ensureWorkspaceWatcher } from './watcher.mjs';

let ptySpawn = null;

export function terminalEnabled() {
  return String(process.env.Z_AGENT_TERMINAL_ENABLED || '').trim() === '1';
}
try {
  const mod = await import('node-pty');
  ptySpawn = mod.spawn || mod.default?.spawn || null;
} catch { /* optional */ }

/**
 * Strict origin check for the terminal socket handshake.
 *
 * A missing Origin header used to pass, which let any non-browser client (and
 * therefore any stolen cookie) open a shell. The handshake is now rejected
 * unless the request carries an Origin that matches the configured allowlist,
 * or the Host the request was sent to.
 */
export function sameOrigin(req) {
  const origin = String(req.headers?.origin || '');
  if (!origin) return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (ALLOWED_ORIGINS.length) {
    return ALLOWED_ORIGINS.some((allowed) => {
      try { return new URL(allowed).origin === parsed.origin; } catch { return allowed === parsed.origin; }
    });
  }
  return parsed.host === String(req.headers?.host || '');
}

function shellEnv(workspace, sessionId) {
  const home = ensureManagedHome(sessionId, workspace);
  return managedShellEnvironment(workspace, {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    USER: 'agent',
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: 'xterm-256color',
  });
}

export async function initTerminal(httpServer) {
  if (!terminalEnabled()) {
    console.info('[terminal] disabled; set Z_AGENT_TERMINAL_ENABLED=1 only for trusted self-hosted deployments');
    return null;
  }
  let SocketIOServer;
  try {
    ({ Server: SocketIOServer } = await import('socket.io'));
  } catch (error) {
    console.warn('[terminal] socket.io is unavailable; terminal transport disabled:', error?.message || error);
    return null;
  }
  const io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 1024 * 1024,
    allowRequest: (req, cb) => cb(null, sameOrigin(req) && Boolean(authFromRequest(req))),
  });

  io.on('connection', (socket) => {
    const auth = authFromRequest(socket.request);
    const sid = String(socket.handshake.query.workdir || '');
    if (!auth || !isSessionId(sid) || !ownsChat(sid, auth.user.email)) {
      socket.emit('data', '\r\n\x1b[31mДоступ к терминалу запрещён.\x1b[0m\r\n');
      socket.disconnect(true);
      return;
    }
    if (!shellSandboxAvailable()) {
      socket.emit('data', '\r\n\x1b[31mТерминал отключён: безопасная Unix-изоляция недоступна. Запустите Z Agent через Docker.\x1b[0m\r\n');
      socket.disconnect(true);
      return;
    }
    const cwd = workspaceFor(sid);
    ensureWorkspaceWatcher(sid, cwd);
    const identity = prepareWorkspaceSandbox(sid, cwd);
    const env = shellEnv(cwd, sid);
    if (ptySpawn) {
      const launch = sandboxCommand(identity, '/bin/bash', ['--noprofile', '--norc', '-i']);
      const pty = ptySpawn(launch.file, launch.args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env, ...launch.options });
      pty.onData((data) => socket.emit('data', data));
      pty.onExit(() => socket.disconnect(true));
      socket.on('data', (data) => pty.write(String(data)));
      socket.on('resize', ({ cols, rows } = {}) => {
        const c = Math.min(Math.max(Number(cols) || 80, 2), 500);
        const r = Math.min(Math.max(Number(rows) || 24, 2), 300);
        try { pty.resize(c, r); } catch {}
      });
      socket.on('disconnect', () => { try { pty.kill(); } catch {} });
      return;
    }

    const launch = sandboxCommand(identity, '/bin/bash', ['--noprofile', '--norc', '-i']);
    const child = spawn(launch.file, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...launch.options });
    child.stdout.on('data', (d) => socket.emit('data', d.toString('utf8')));
    child.stderr.on('data', (d) => socket.emit('data', d.toString('utf8')));
    socket.on('data', (data) => child.stdin.write(String(data)));
    socket.on('disconnect', () => child.kill('SIGTERM'));
    child.on('close', () => socket.disconnect(true));
  });
  return io;
}
