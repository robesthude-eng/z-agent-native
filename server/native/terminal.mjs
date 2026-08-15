import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { authFromRequest } from './auth.mjs';
import { managedShellEnvironment } from './environment.mjs';
import { ownsChat, workspaceFor } from './store.mjs';
import { prepareWorkspaceSandbox, shellSandboxAvailable } from './sandbox.mjs';
import { ensureWorkspaceWatcher } from './watcher.mjs';

let ptySpawn = null;
try {
  const mod = await import('node-pty');
  ptySpawn = mod.spawn || mod.default?.spawn || null;
} catch { /* optional */ }

export function sameOrigin(req) {
  const origin = String(req.headers?.origin || '');
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === String(req.headers?.host || '');
  } catch { return false; }
}

function shellEnv(workspace) {
  const home = `${workspace}/.agent-home`;
  fs.mkdirSync(home, { recursive: true });
  return managedShellEnvironment(workspace, {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    USER: 'agent',
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: 'xterm-256color',
  });
}

export async function initTerminal(httpServer) {
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
    if (!auth || !/^ses_[a-zA-Z0-9]+$/.test(sid) || !ownsChat(sid, auth.user.email)) {
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
    const env = shellEnv(cwd);
    const identity = prepareWorkspaceSandbox(sid, cwd);
    if (ptySpawn) {
      const command = identity.isolated ? '/usr/bin/setpriv' : '/bin/bash';
      const args = identity.isolated
        ? [`--reuid=${identity.uid}`, `--regid=${identity.gid}`, '--clear-groups', '--', '/bin/bash', '--noprofile', '--norc', '-i']
        : ['--noprofile', '--norc', '-i'];
      const pty = ptySpawn(command, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
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

    const child = spawn('/bin/bash', ['-i'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...(identity.isolated ? { uid: identity.uid, gid: identity.gid } : {}) });
    child.stdout.on('data', (d) => socket.emit('data', d.toString('utf8')));
    child.stderr.on('data', (d) => socket.emit('data', d.toString('utf8')));
    socket.on('data', (data) => child.stdin.write(String(data)));
    socket.on('disconnect', () => child.kill('SIGTERM'));
    child.on('close', () => socket.disconnect(true));
  });
  return io;
}
