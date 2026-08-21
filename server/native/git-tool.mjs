import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureManagedHome, sandboxCommand } from './sandbox.mjs';
import { executeInExecutor } from './executor-client.mjs';
import { safeWorkspacePath } from './security.mjs';

const MAX_GIT_OUTPUT = 256 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_TIMEOUT_MS = 600_000;

// git must inherit nothing from the server process: a stray GIT_DIR,
// GIT_SSH_COMMAND or GIT_ASKPASS in the parent environment would silently
// redirect every agent git call outside the workspace.
const GIT_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];

// Built with RegExp(string) on purpose: these classes contain '/' and '-' and
// are far easier to review without literal-escaping noise.
const REV_PATTERN = new RegExp('^[A-Za-z0-9._@^~{}/-]{1,200}$');
const BRANCH_PATTERN = new RegExp('^[A-Za-z0-9._/-]{1,120}$');

export const GIT_ACTIONS = ['status', 'log', 'diff', 'blame', 'show', 'branches', 'create_branch', 'commit'];
const MUTATING_ACTIONS = new Set(['create_branch', 'commit']);

export function gitActionMutates(action) {
  return MUTATING_ACTIONS.has(String(action || '').trim().toLowerCase());
}

function gitEnv(root) {
  const env = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.PATH = env.PATH || '/usr/local/bin:/usr/bin:/bin';
  env.HOME = path.join(root, '.agent-home');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function truncateGit(text) {
  const value = String(text ?? '');
  if (value.length <= MAX_GIT_OUTPUT) return value;
  return `${value.slice(0, MAX_GIT_OUTPUT)}\n\n[git output truncated: ${value.length - MAX_GIT_OUTPUT} chars omitted]`;
}

function assertRev(value, label) {
  const rev = String(value ?? '').trim();
  if (!rev) throw new Error(`${label} must not be empty`);
  // A value starting with '-' would be parsed by git as an option, which is how
  // an innocent-looking argument turns into arbitrary git behaviour.
  if (rev.startsWith('-')) throw new Error(`${label} must not start with "-"`);
  if (!REV_PATTERN.test(rev)) throw new Error(`${label} contains unsupported characters`);
  return rev;
}

function relativePathArg(root, value, label) {
  const full = safeWorkspacePath(root, value, { allowMissing: true });
  const relative = path.relative(root, full).split(path.sep).join('/');
  if (!relative || relative.startsWith('..')) throw new Error(`${label} must point inside the workspace`);
  return relative;
}

export function buildGitArgs(root, action, input = {}) {
  const rawPaths = Array.isArray(input.paths) ? input.paths.slice(0, 20) : [];
  const paths = rawPaths.map((value, index) => relativePathArg(root, value, `paths[${index}]`));

  if (action === 'status') return { args: ['status', '--porcelain=v1', '--branch'], title: 'git status' };

  if (action === 'branches') return { args: ['branch', '--all', '--verbose', '--no-color'], title: 'git branch' };

  if (action === 'log') {
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 200);
    const args = ['log', '--no-color', `--max-count=${limit}`, '--date=short', '--pretty=format:%h  %ad  %an  %s'];
    if (input.rev) args.push(assertRev(input.rev, 'rev'));
    if (paths.length) args.push('--', ...paths);
    return { args, title: 'git log' };
  }

  if (action === 'diff') {
    const args = ['diff', '--no-color'];
    if (input.staged) args.push('--staged');
    if (input.stat) args.push('--stat');
    if (input.rev) args.push(assertRev(input.rev, 'rev'));
    if (paths.length) args.push('--', ...paths);
    return { args, title: 'git diff' };
  }

  if (action === 'blame') {
    if (paths.length !== 1) throw new Error('blame requires exactly one entry in paths');
    const args = ['blame', '--no-color', '--date=short'];
    const start = Number(input.startLine);
    if (Number.isFinite(start) && start > 0) {
      const from = Math.floor(start);
      const rawEnd = Number(input.endLine);
      const to = Number.isFinite(rawEnd) && rawEnd >= from ? Math.floor(rawEnd) : from + 200;
      args.push('-L', `${from},${to}`);
    }
    args.push('--', paths[0]);
    return { args, title: `git blame ${paths[0]}` };
  }

  if (action === 'show') {
    const rev = assertRev(input.rev || 'HEAD', 'rev');
    const args = ['show', '--no-color', '--stat', rev];
    if (paths.length) args.push('--', ...paths);
    return { args, title: `git show ${rev}` };
  }

  if (action === 'create_branch') {
    const branch = String(input.branch || '').trim();
    if (!branch) throw new Error('create_branch requires branch');
    if (branch.startsWith('-') || branch.includes('..') || !BRANCH_PATTERN.test(branch)) {
      throw new Error('branch name is not allowed');
    }
    return { args: ['checkout', '-b', branch], title: `git checkout -b ${branch}` };
  }

  if (action === 'commit') {
    const message = String(input.message || '').trim();
    if (!message) throw new Error('commit requires message');
    if (message.length > 4000) throw new Error('commit message is too long (max 4000 characters)');
    // Identity is supplied per invocation so the tool never depends on, and
    // never writes, global git config inside the workspace.
    const args = ['-c', 'user.name=Z Agent', '-c', 'user.email=agent@z-agent.local', 'commit', '-m', message];
    if (paths.length) args.push('--', ...paths);
    else args.push('--all');
    return { args, title: 'git commit' };
  }

  throw new Error(`Unsupported git action "${action}". Use one of: ${GIT_ACTIONS.join(', ')}`);
}

async function runGit(root, identity, args, signal, timeoutMs) {
  const budget = Math.min(Math.max(Number(timeoutMs) || DEFAULT_GIT_TIMEOUT_MS, 1000), MAX_GIT_TIMEOUT_MS);
  if (identity?.isolated) {
    const remote = await executeInExecutor({
      workspace: root, uid: identity.uid, gid: identity.gid, file: 'git', args, env: gitEnv(root), timeoutMs: budget, signal,
    });
    if (remote) return { code: Number(remote.code) || 0, stdout: truncateGit(remote.stdout), stderr: truncateGit(remote.stderr) };
  }
  const launch = sandboxCommand(identity, 'git', args);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      cwd: root,
      env: gitEnv(root),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...launch.options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = truncateGit(stdout + chunk.toString('utf8')); });
    child.stderr.on('data', (chunk) => { stderr = truncateGit(stderr + chunk.toString('utf8')); });
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
  });
}

export async function executeGitTool({ root, identity, input = {}, signal, sessionId = null }) {
  ensureManagedHome(sessionId, root);
  const action = String(input.action || '').trim().toLowerCase();
  if (!GIT_ACTIONS.includes(action)) {
    throw new Error(`Unsupported git action "${input.action}". Use one of: ${GIT_ACTIONS.join(', ')}`);
  }
  const plan = buildGitArgs(root, action, input);
  const result = await runGit(root, identity, plan.args, signal, input.timeoutMs);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    if (/not a git repository/i.test(detail)) {
      throw new Error('This workspace is not a git repository yet. Initialize one with bash before using git actions.');
    }
    throw new Error(detail || `${plan.title} exited with code ${result.code}`);
  }
  const body = (result.stdout || '').trim() || (result.stderr || '').trim();
  return {
    output: body || `${plan.title}: no output`,
    title: plan.title,
    mutatedPaths: gitActionMutates(action) ? ['.'] : [],
    metadata: { git: { action, exit: result.code } },
  };
}
