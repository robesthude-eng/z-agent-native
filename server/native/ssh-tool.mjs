import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureManagedHome, sandboxCommand } from './sandbox.mjs';
import { safeWorkspacePath } from './security.mjs';
import { shellNetworkPolicy, sshHostAllowlist, sshPolicy } from './workspace-policy.mjs';

const MAX_SSH_OUTPUT = 256 * 1024;
const DEFAULT_SSH_TIMEOUT_MS = 60_000;
const MAX_SSH_TIMEOUT_MS = 900_000;

export const SSH_ACTIONS = ['test', 'exec', 'read', 'write', 'patch', 'service'];
export const SSH_SERVICE_ACTIONS = ['status', 'restart', 'start', 'stop', 'logs'];

const MUTATING_ACTIONS = new Set(['write', 'patch']);
// service start/stop/restart change remote state but never the local workspace,
// which is what mutatedPaths tracks; they are reported through metadata instead.
export function sshActionMutatesRemote(action) {
  const value = String(action || '').trim().toLowerCase();
  return MUTATING_ACTIONS.has(value) || value === 'service';
}

// Hostnames, IPv4 and bracketless IPv6. A leading '-' would be parsed by the
// CLI as an option, which is how a hostname turns into arbitrary argv.
const HOST_PATTERN = /^[A-Za-z0-9._:-]{1,253}$/;
const USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9@._-]{1,128}$/;

function truncateSsh(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_SSH_OUTPUT) return value;
  return `${value.slice(0, MAX_SSH_OUTPUT)}\n\n[ssh_tool output truncated: ${value.length - MAX_SSH_OUTPUT} chars omitted]`;
}

function assertPattern(value, pattern, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.startsWith('-')) throw new Error(`${label} must not start with "-"`);
  if (!pattern.test(text)) throw new Error(`${label} contains unsupported characters`);
  return text;
}

/**
 * Egress gate for remote SSH.
 *
 * ssh_tool is structured but still grants remote code execution. It therefore
 * needs an explicit SSH policy instead of inheriting public web access.
 */
export function assertSshDestinationAllowed(host) {
  if (shellNetworkPolicy() === 'tool-only') {
    throw Object.assign(new Error('Remote SSH is blocked by Z_AGENT_SHELL_NETWORK_POLICY=tool-only.'), {
      statusCode: 403,
      code: 'SSH_EGRESS_BLOCKED',
    });
  }
  const policy = sshPolicy();
  if (policy === 'off') {
    throw Object.assign(new Error('Remote SSH is disabled by Z_AGENT_SSH_POLICY=off.'), {
      statusCode: 403,
      code: 'SSH_DISABLED',
    });
  }
  const allowed = sshHostAllowlist();
  if (policy === 'allowlist' && (!allowed.length || !allowed.includes(String(host || '').toLowerCase()))) {
    throw Object.assign(new Error(`SSH host is not in Z_AGENT_SSH_ALLOWLIST: ${host}`), {
      statusCode: 403,
      code: 'SSH_HOST_BLOCKED',
    });
  }
}

export { sshHostAllowlist, sshPolicy };

/**
 * Locate the CLI. Docker installs it as /usr/local/bin/ssh_tool; a source
 * checkout runs the script through python3 so local tests behave identically.
 */
export function resolveSshToolLauncher() {
  const installed = '/usr/local/bin/ssh_tool';
  try {
    fs.accessSync(installed, fs.constants.X_OK);
    return { file: installed, prefix: [] };
  } catch { /* fall through to the source checkout */ }
  const script = new URL('../ssh_tool.py', import.meta.url).pathname;
  if (!fs.existsSync(script)) {
    throw new Error('ssh_tool is not installed in this runtime image.');
  }
  return { file: 'python3', prefix: [script] };
}

function keyArgs(root, value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  // Keys live in the workspace and are addressed relatively. Resolving through
  // safeWorkspacePath keeps `../../root/.ssh/id_rsa` from leaving the sandbox.
  const full = safeWorkspacePath(root, String(value), { allowMissing: false });
  try {
    // paramiko refuses group/world-readable keys the same way OpenSSH does, and
    // an unpacked archive routinely lands at 0644.
    fs.chmodSync(full, 0o600);
  } catch { /* best effort; paramiko reports the real problem */ }
  return ['--key', full];
}

export function buildSshArgs(root, action, input = {}) {
  const host = assertPattern(input.host, HOST_PATTERN, 'host');
  const user = assertPattern(input.user || 'root', USER_PATTERN, 'user');
  const port = Math.min(Math.max(Number(input.port) || 22, 1), 65535);
  const timeoutSeconds = Math.min(Math.max(Math.round((Number(input.timeoutMs) || DEFAULT_SSH_TIMEOUT_MS) / 1000), 5), 900);

  const conn = ['--host', host, '--user', user, '--port', String(port), '--timeout', String(timeoutSeconds), ...keyArgs(root, input.key)];
  if (input.sudo) conn.push('--sudo');

  if (action === 'test') return { args: ['test', ...conn], title: `ssh test ${user}@${host}`, stdin: '' };

  if (action === 'exec') {
    const command = String(input.command ?? '').trim();
    if (!command) throw new Error('exec requires command');
    if (command.length > 8000) throw new Error('command is too long (max 8000 characters)');
    // Passed as a single argv element, so the local shell never re-parses it.
    return { args: ['exec', ...conn, '--cmd', command], title: `ssh ${user}@${host}: ${command}`, stdin: '' };
  }

  if (action === 'read') {
    const remotePath = String(input.path ?? '').trim();
    if (!remotePath) throw new Error('read requires path');
    const offset = Math.max(Number(input.offset) || 1, 1);
    const limit = Math.min(Math.max(Number(input.limit) || 200, 1), 4000);
    return {
      args: ['read', ...conn, '--path', remotePath, '--offset', String(offset), '--limit', String(limit)],
      title: `ssh read ${host}:${remotePath}`,
      stdin: '',
    };
  }

  if (action === 'write') {
    const remotePath = String(input.path ?? '').trim();
    if (!remotePath) throw new Error('write requires path');
    if (typeof input.content !== 'string') throw new Error('write requires content');
    // Content goes over stdin, never argv: a large file would blow past ARG_MAX
    // and the whole body would otherwise be visible in /proc/<pid>/cmdline.
    return { args: ['write', ...conn, '--path', remotePath], title: `ssh write ${host}:${remotePath}`, stdin: input.content };
  }

  if (action === 'patch') {
    const remotePath = String(input.path ?? '').trim();
    if (!remotePath) throw new Error('patch requires path');
    const oldText = String(input.oldText ?? '');
    const newText = String(input.newText ?? '');
    if (!oldText) throw new Error('patch requires oldText');
    return {
      args: ['patch', ...conn, '--path', remotePath, '--old', oldText, '--new', newText],
      title: `ssh patch ${host}:${remotePath}`,
      stdin: '',
    };
  }

  if (action === 'service') {
    const name = assertPattern(input.name, SERVICE_PATTERN, 'name');
    const serviceAction = String(input.serviceAction || 'status').trim().toLowerCase();
    if (!SSH_SERVICE_ACTIONS.includes(serviceAction)) {
      throw new Error(`Unsupported serviceAction "${input.serviceAction}". Use one of: ${SSH_SERVICE_ACTIONS.join(', ')}`);
    }
    return {
      args: ['service', ...conn, '--name', name, '--action', serviceAction],
      title: `ssh service ${name} ${serviceAction} @ ${host}`,
      stdin: '',
    };
  }

  throw new Error(`Unsupported ssh_tool action "${action}". Use one of: ${SSH_ACTIONS.join(', ')}`);
}

function sshEnv(root, home, password) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: process.env.LANG || 'C.UTF-8',
    PYTHONUNBUFFERED: '1',
    // Nothing in the session UID resolves through NSS, so Python must not try
    // to look the user up when it expands '~'.
    PYTHONDONTWRITEBYTECODE: '1',
  };
  if (password) env.Z_AGENT_SSH_PASSWORD = String(password);
  return env;
}

/**
 * Run ssh_tool locally under the session identity.
 *
 * Deliberately NOT routed through executeInExecutor: the executor container is
 * `network_mode: none`, so every SSH connection attempted there would fail with
 * an unroutable-network error that looks nothing like the real cause.
 */
async function runSshTool(root, identity, plan, signal, timeoutMs, onOutput) {
  const budget = Math.min(Math.max(Number(timeoutMs) || DEFAULT_SSH_TIMEOUT_MS, 1000), MAX_SSH_TIMEOUT_MS);
  const home = path.join(root, '.agent-home');
  const launcher = resolveSshToolLauncher();
  const launch = sandboxCommand(identity, launcher.file, [...launcher.prefix, ...plan.args]);

  return await new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      cwd: root,
      env: sshEnv(root, home, plan.password),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...launch.options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = truncateSsh(stdout + chunk.toString('utf8'));
      if (typeof onOutput === 'function') onOutput(stdout, stderr);
    });
    child.stderr.on('data', (chunk) => {
      stderr = truncateSsh(stderr + chunk.toString('utf8'));
      if (typeof onOutput === 'function') onOutput(stdout, stderr);
    });
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
    const timer = setTimeout(kill, budget);
    timer.unref?.();
    signal?.addEventListener('abort', kill, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
    };
    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('close', (code) => { cleanup(); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.end(String(plan.stdin ?? ''));
  });
}

export async function executeSshTool({ root, identity, input = {}, signal, sessionId = null, onOutput = null }) {
  const action = String(input.action || '').trim().toLowerCase();
  if (!SSH_ACTIONS.includes(action)) {
    throw new Error(`Unsupported ssh_tool action "${input.action}". Use one of: ${SSH_ACTIONS.join(', ')}`);
  }
  ensureManagedHome(sessionId, root);
  const plan = buildSshArgs(root, action, input);
  assertSshDestinationAllowed(String(input.host || '').trim());
  // Kept off argv so the credential never appears in /proc/<pid>/cmdline or in
  // the tool title echoed back into the transcript.
  plan.password = input.password ? String(input.password) : '';

  const result = await runSshTool(root, identity, plan, signal, input.timeoutMs, onOutput);
  const body = [
    `exit=${result.code}`,
    result.stdout && `stdout:\n${result.stdout}`,
    result.stderr && `stderr:\n${result.stderr}`,
  ].filter(Boolean).join('\n');

  if (result.code !== 0 && action === 'test') {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `ssh_tool test exited with code ${result.code}`);
  }

  return {
    output: body,
    title: plan.title,
    // Remote changes never touch the local workspace snapshot.
    mutatedPaths: [],
    metadata: { ssh: { action, host: String(input.host || ''), exit: result.code, remoteMutation: sshActionMutatesRemote(action) } },
  };
}
