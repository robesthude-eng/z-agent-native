import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { DEFAULT_TOOL_TIMEOUT_MS, GREP_TIMEOUT_MS } from './config.mjs';
import {
  commitEnvironmentRequirement, describeManagedEnvironment, managedShellEnvironment, prepareEnvironmentRequirement,
} from './environment.mjs';
import { EXTENDED_TOOLCHAIN_KINDS, prepareToolchainRequirement, suggestToolchainForCommand } from './toolchains.mjs';
import { buildRepoMap, formatRepoMap } from './repo-intelligence.mjs';
import { GIT_ACTIONS, executeGitTool } from './git-tool.mjs';
import { buildTestCommand, formatTestReport } from './test-runner.mjs';
import { DIAGNOSTIC_KINDS, formatDiagnosticsReport, planDiagnostics } from './diagnostics.mjs';
import { BROWSER_ACTIONS, executeBrowserTool } from './browser-client.mjs';
import { subagentKinds } from './subagents.mjs';
import { classifyBash } from './context.mjs';
import { safeExternalRequest, safeWorkspacePath } from './security.mjs';
import { prepareWorkspaceSandbox, sandboxCommand, sandboxIdentity, shellSandboxAvailable, syncSandboxOwnership } from './sandbox.mjs';
import { executeInExecutor, executorRequired } from './executor-client.mjs';
import { agentNetworkPolicy, assertAgentNetworkHost, assertAgentNetworkUrl, assertAgentReadablePath, assertShellCommandAllowed, isSensitiveWorkspacePath, shellNetworkPolicy } from './workspace-policy.mjs';

const MAX_READ_BYTES = 512 * 1024;
const MAX_TOOL_OUTPUT = 512 * 1024;
const MAX_MATCH_LINE = 2000;
const MAX_PATTERN_CHARS = 1000;
const MAX_WALK_ENTRIES = 10_000;
const IGNORED_WALK_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.agent-home']);
const BASE_ENVIRONMENT_KINDS = ['python', 'java', 'gradle', 'android'];
const ENVIRONMENT_KINDS = [...BASE_ENVIRONMENT_KINDS, ...EXTENDED_TOOLCHAIN_KINDS];

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_DEFINITIONS = [
  {
    name: 'read',
    description: 'Read a numbered UTF-8 line window from a workspace file. Supports large text files via offset/limit without loading the whole file.',
    inputSchema: object({ path: { type: 'string', description: 'Relative file path' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 4000 } }, ['path']),
  },
  {
    name: 'list',
    description: 'List files/directories in the current workspace. Heavy generated/vendor directories are skipped.',
    inputSchema: object({ path: { type: 'string', description: 'Relative directory, default .' }, depth: { type: 'integer', minimum: 1, maximum: 6 } }),
  },
  {
    name: 'glob',
    description: 'Find workspace files by a simple glob such as **/*.ts, src/**, *.json. **/ also matches the workspace root.',
    inputSchema: object({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
  },
  {
    name: 'grep',
    description: 'Search UTF-8 workspace files for text or a regular expression.',
    inputSchema: object({ query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: 300 } }, ['query']),
  },
  {
    name: 'repo_map',
    description: 'Build a bounded high-signal map of a repository or subtree: languages, manifests/scripts, likely entrypoints, important directories, import hubs, symbols, configs and tests. Use before broad codebase investigation.',
    inputSchema: object({
      path: { type: 'string', description: 'Relative repository/subtree path, default .' },
      maxFiles: { type: 'integer', minimum: 100, maximum: 8000 },
      maxSymbolsPerFile: { type: 'integer', minimum: 0, maximum: 20 },
    }),
  },
  {
    name: 'write',
    description: 'Create or replace a UTF-8 file in the workspace.',
    inputSchema: object({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'edit',
    description: 'Replace exact text in a UTF-8 workspace file. Safer than rewriting the whole file.',
    inputSchema: object({ path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, all: { type: 'boolean' } }, ['path', 'oldText', 'newText']),
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff to files in the current workspace. Paths must be relative and stay inside the workspace.',
    inputSchema: object({ patch: { type: 'string', description: 'Unified diff / git diff text' } }, ['patch']),
  },
  {
    name: 'todowrite',
    description: 'Track the plan for a multi-step task. Keep the list concise and update statuses as work progresses.',
    inputSchema: object({
      todos: {
        type: 'array', maxItems: 30,
        items: object({
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        }, ['content', 'status']),
      },
    }, ['todos']),
  },
  {
    name: 'task',
    description: 'Delegate focused work to a specialized subagent using the same model. Choose explore for architecture/navigation, debug for root-cause tracing, review for defect-focused code review, or implement to carry out and verify a scoped change. explore/debug/review are read-only; only implement may modify files.',
    inputSchema: object({
      // Sourced from the profile registry so a new profile can never silently
      // become unreachable through the schema.
      agent: { type: 'string', enum: subagentKinds(), description: 'Specialized subagent role; defaults to explore. Only implement may modify files.' },
      description: { type: 'string' },
      prompt: { type: 'string' },
    }, ['prompt']),
  },
  {
    name: 'ensure_environment',
    description: 'Provision a missing development runtime or CLI inside this session without sudo, then keep it on PATH for later bash/terminal calls. Supports Python packages, Java, Gradle, Android SDK, Go, Rust, Node.js, Maven, Flutter, kubectl, Terraform, and checksum-pinned portable binaries.',
    inputSchema: object({
      kind: { type: 'string', enum: ENVIRONMENT_KINDS },
      version: { type: 'string', description: 'Requested tool version/channel. Many toolchains accept latest/stable/lts/current as documented by the tool.' },
      packages: { type: 'array', maxItems: 30, items: { type: 'string' }, description: 'pip package specs for python, or sdkmanager package IDs for android.' },
      acceptLicenses: { type: 'boolean', description: 'For Android SDK packages, explicitly accept Android SDK licenses. The permission dialog will show this value.' },
      name: { type: 'string', description: 'For kind=portable, command name to expose on PATH.' },
      url: { type: 'string', description: 'For kind=portable, official HTTPS download URL.' },
      sha256: { type: 'string', description: 'For kind=portable, expected SHA-256 of the downloaded artifact.' },
      archiveType: { type: 'string', enum: ['raw', 'zip', 'tar.gz', 'tar.xz'], description: 'For kind=portable, downloaded artifact format.' },
      binaryPath: { type: 'string', description: 'For archived kind=portable artifacts, relative path to the executable inside the archive.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
    }, ['kind']),
  },
  {
    name: 'environment_status',
    description: 'Inspect the managed session environment and check whether named commands are currently available on PATH. Use before provisioning when tool availability is unclear.',
    inputSchema: object({ commands: { type: 'array', maxItems: 40, items: { type: 'string' } } }),
  },
  {
    name: 'bash',
    description: 'Run a shell command in the current workspace. Direct network clients and credential-like files are blocked by the default guarded egress policy; use structured web/environment/git tools where possible.',
    inputSchema: object({ command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 } }, ['command']),
  },
  {
    name: 'webfetch',
    description: 'Fetch a public HTTP(S) URL. Private, loopback and link-local destinations are blocked.',
    inputSchema: object({ url: { type: 'string' }, maxChars: { type: 'integer', minimum: 1000, maximum: 200000 } }, ['url']),
  },
  {
    name: 'websearch',
    description: 'Search the public web with the server-configured Brave Search API. Returns titles, URLs and snippets.',
    inputSchema: object({ query: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 10 } }, ['query']),
  },
  {
    name: 'question',
    description: 'Ask the user one or more questions and wait for the answer in the same agent turn. Use only when user input is genuinely required.',
    inputSchema: object({
      questions: {
        type: 'array', minItems: 1, maxItems: 8,
        items: object({
          question: { type: 'string' },
          header: { type: 'string' },
          options: { type: 'array', items: object({ label: { type: 'string' }, description: { type: 'string' } }, ['label']), maxItems: 12 },
          allowCustomResponse: { type: 'boolean' },
        }, ['question']),
      },
    }, ['questions']),
  },
  {
    name: 'git',
    description: 'Inspect and record repository history: status, log, diff, show, blame, branches, create_branch, commit. Use this instead of bash for git work; arguments are passed as structured argv, never as a shell string.',
    inputSchema: object({
      action: { type: 'string', enum: GIT_ACTIONS },
      rev: { type: 'string', description: 'Commit, tag, branch, or range such as HEAD~3..HEAD.' },
      paths: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Workspace-relative paths to limit the operation to.' },
      branch: { type: 'string' },
      message: { type: 'string', description: 'Commit message, required for action=commit.' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
      staged: { type: 'boolean', description: 'For diff: show staged changes instead of the working tree.' },
      stat: { type: 'boolean', description: 'For diff/show: summary of changed files instead of full patch text.' },
      timeoutMs: { type: 'integer' },
    }, ['action']),
  },
  {
    name: 'run_tests',
    description: 'Run the project test suite and return a structured verdict: pass/fail totals plus the names and messages of failing tests, instead of raw log spam. Auto-detects the runner when command is omitted.',
    inputSchema: object({
      command: { type: 'string', description: 'Explicit test command. Omit to auto-detect from package.json, pytest, go, cargo, or gradle.' },
      filter: { type: 'string', description: 'Test name or path filter passed through to the detected runner.' },
      timeoutMs: { type: 'integer' },
    }),
  },
  {
    name: 'diagnostics',
    description: 'Run the project typecheck and/or lint commands and return parsed file:line:column diagnostics grouped by severity. Use after edits instead of reading whole compiler logs.',
    inputSchema: object({
      kind: { type: 'string', enum: DIAGNOSTIC_KINDS, description: 'all (default), typecheck, or lint.' },
      command: { type: 'string', description: 'Explicit checker command. Omit to auto-detect.' },
      timeoutMs: { type: 'integer' },
    }),
  },
  {
    name: 'browser',
    description: 'Drive a headless Chromium page: open, snapshot, click, fill, press, console, close. Returns page text plus interactive elements. Use for JavaScript-rendered pages and for verifying UI changes; use webfetch for static content.',
    inputSchema: object({
      action: { type: 'string', enum: BROWSER_ACTIONS },
      url: { type: 'string', description: 'Required for action=open.' },
      selector: { type: 'string', description: 'CSS selector for the target element.' },
      text: { type: 'string', description: 'Visible text used to locate the element when selector is not given.' },
      value: { type: 'string', description: 'Value for action=fill.' },
      key: { type: 'string', description: 'Key for action=press, for example Enter.' },
      timeoutMs: { type: 'integer' },
    }, ['action']),
  },
];

const risky = new Set(['write', 'edit', 'apply_patch', 'ensure_environment', 'bash', 'webfetch', 'websearch', 'git', 'run_tests', 'diagnostics', 'browser']);
export function requiresPermission(name) { return risky.has(String(name).toLowerCase()); }
export function mutatesWorkspace(name) { return ['write', 'edit', 'apply_patch', 'bash', 'git', 'run_tests'].includes(String(name).toLowerCase()); }

// Everything that spawns a process or drives a browser must be gated exactly
// like bash: without a session sandbox there is no isolation to run it in.
const SANDBOXED_TOOLS = ['bash', 'apply_patch', 'ensure_environment', 'git', 'run_tests', 'diagnostics', 'browser'];
export function availableToolDefinitions() {
  let tools = shellSandboxAvailable() ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((tool) => !SANDBOXED_TOOLS.includes(tool.name));
  // The hardened executor has no network by construction. Dependency installers
  // therefore cannot be autonomous in production without creating a second
  // code-execution egress path. Provision dependencies in the image/operator
  // workflow instead; trusted local mode may explicitly retain this tool.
  if (executorRequired() && process.env.Z_AGENT_ALLOW_NETWORKED_INSTALLERS !== '1') tools = tools.filter((tool) => tool.name !== 'ensure_environment');
  return tools;
}

function rel(root, full) { return path.relative(root, full).split(path.sep).join('/'); }
function textResult(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function truncate(text, max = MAX_TOOL_OUTPUT) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[output truncated: ${s.length - max} chars omitted]`;
}

function walk(root, start, depth, out, baseDepth = 0) {
  if (baseDepth > depth || out.length >= MAX_WALK_ENTRIES) return;
  let entries;
  try { entries = fs.readdirSync(start, { withFileTypes: true }); } catch { return; }
  entries.sort((a,b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_WALK_ENTRIES) break;
    if (entry.isDirectory() && IGNORED_WALK_DIRS.has(entry.name)) continue;
    const full = path.join(start, entry.name);
    const relative = rel(root, full);
    out.push({ path: relative, type: entry.isDirectory() ? 'directory' : 'file' });
    if (entry.isDirectory()) walk(root, full, depth, out, baseDepth + 1);
  }
}

function globRegex(glob) {
  const input = String(glob || '').replace(/\\/g, '/');
  let s = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '*' && input[i + 1] === '*') {
      if (input[i + 2] === '/') {
        s += '(?:.*/)?';
        i += 2;
      } else {
        s += '.*';
        i += 1;
      }
    } else if (ch === '*') s += '[^/]*';
    else if (ch === '?') s += '[^/]';
    else s += ch.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}

function readUtf8(full) {
  const buf = fs.readFileSync(full);
  if (buf.length > MAX_READ_BYTES) throw new Error(`File is too large for whole-file editing (${buf.length} bytes); use read with offset/limit to inspect it`);
  if (buf.includes(0)) throw new Error('Binary file: use bash or a specialized tool instead');
  return buf.toString('utf8');
}

async function readUtf8Window(full, offset, limit) {
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('Path is not a file');
  const fd = fs.openSync(full, 'r');
  try {
    const probe = Buffer.alloc(Math.min(8192, stat.size));
    if (probe.length) fs.readSync(fd, probe, 0, probe.length, 0);
    if (probe.includes(0)) throw new Error('Binary file: use bash or a specialized tool instead');
  } finally {
    fs.closeSync(fd);
  }

  const stream = fs.createReadStream(full, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const rows = [];
  let lineNo = 0;
  try {
    for await (const line of rl) {
      if (lineNo >= offset && rows.length < limit) rows.push(`${lineNo + 1}: ${line}`);
      lineNo += 1;
      if (rows.length >= limit) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return rows.join('\n');
}

function externalSpawnIdentity(ctx, root) {
  if (ctx?.sessionId) return prepareWorkspaceSandbox(ctx.sessionId, root);
  if (process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL === '1') return { isolated: false };
  throw new Error('External tool execution requires a session sandbox');
}

/**
 * Run file scanning off the main thread with a hard deadline. Literal search
 * cannot catastrophically backtrack, but synchronous reads across thousands
 * of files still block every HTTP/SSE client on the main Node thread.
 */
async function grepInWorker(files, pattern, max, timeoutMs, regex) {
  const workerUrl = new URL('./grep-worker.mjs', import.meta.url);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerUrl, {
      workerData: { files, pattern, max, regex, maxBytes: MAX_READ_BYTES, maxLine: MAX_MATCH_LINE },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error(`grep: search exceeded ${timeoutMs} ms and was cancelled. Simplify the pattern or narrow the path.`), { statusCode: 408 }));
    }, timeoutMs);
    timer.unref?.();
    worker.on('message', (message) => {
      if (message?.error) finish(reject, new Error(`grep: ${message.error}`));
      else finish(resolve, Array.isArray(message?.hits) ? message.hits : []);
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', () => finish(resolve, []));
  });
}

async function execBash(root, command, timeoutMs, signal, ctx) {
  const home = path.join(root, '.agent-home');
  fs.mkdirSync(home, { recursive: true });
  const identity = externalSpawnIdentity(ctx, root);
  const env = managedShellEnvironment(root, {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    USER: 'agent',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    TERM: 'xterm-256color',
  });

  // Production Docker routes all autonomous code execution through a sibling
  // executor container with network_mode:none and no /data mount. This is the
  // actual egress boundary; command-text heuristics remain defense in depth.
  if (identity?.isolated) {
    const remote = await executeInExecutor({
      workspace: root, uid: identity.uid, gid: identity.gid,
      file: '/bin/bash', args: ['--noprofile', '--norc', '-c', command],
      env, timeoutMs, signal,
    });
    if (remote) return remote;
  }

  // Local execution exists only for tests and explicitly unsafe development
  // deployments. In production Z_AGENT_EXECUTOR_REQUIRED=1 makes this path
  // unreachable if the Unix-socket executor is unavailable.
  const launch = sandboxCommand(identity, '/bin/bash', ['--noprofile', '--norc', '-c', command]);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...launch.options,
    });
    let stdout = '';
    let stderr = '';
    const push = (which, chunk) => {
      const next = Buffer.from(chunk).toString('utf8');
      if (which === 'out') stdout = truncate(stdout + next);
      else stderr = truncate(stderr + next);
    };
    child.stdout.on('data', (c) => push('out', c));
    child.stderr.on('data', (c) => push('err', c));
    const killGroup = (signalName) => {
      try { process.kill(-child.pid, signalName); } catch { try { child.kill(signalName); } catch {} }
    };
    let forceKillTimer = null;
    const terminateGroup = () => {
      killGroup('SIGTERM');
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null;
        killGroup('SIGKILL');
      }, 1000);
      forceKillTimer.unref?.();
    };
    const timeout = setTimeout(terminateGroup, Math.min(Math.max(timeoutMs || DEFAULT_TOOL_TIMEOUT_MS, 1000), 1_800_000));
    timeout.unref?.();
    const abort = () => terminateGroup();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', abort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', abort);
      // Reap stragglers that outlived the shell, but never re-signal a group that
      // was already terminated above.
      if (!forceKillTimer) killGroup('SIGTERM');
      resolve({ code: code ?? (sig ? 130 : 1), stdout, stderr, signal: sig || null });
    });
  });
}

function assertSafePatchPath(raw) {
  let value = String(raw || '').trim().split('\t')[0];
  if (!value || value === '/dev/null') return;
  // git quotes paths containing spaces or non-ASCII bytes; unquote before
  // checking so `"a/../../etc/passwd"` cannot walk past the naive prefix strip.
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch { throw new Error(`Unsafe patch path: ${raw}`); }
  }
  value = value.replace(/^[ab]\//, '');
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes('..') || value.includes('\0')) throw new Error(`Unsafe patch path: ${value}`);
}

function validatePatchPaths(patchText) {
  for (const line of String(patchText || '').split('\n')) {
    // `--- / +++` are not the only headers git apply reads a destination from:
    // a rename or copy header carries its own paths, and for a pure rename
    // there are no ---/+++ lines at all, so the old loop validated nothing.
    if (line.startsWith('--- ') || line.startsWith('+++ ')) assertSafePatchPath(line.slice(4));
    else if (line.startsWith('rename from ')) assertSafePatchPath(line.slice(12));
    else if (line.startsWith('rename to ')) assertSafePatchPath(line.slice(10));
    else if (line.startsWith('copy from ')) assertSafePatchPath(line.slice(10));
    else if (line.startsWith('copy to ')) assertSafePatchPath(line.slice(8));
    else if (line.startsWith('diff --git ')) {
      // Two paths on one line, either of which may contain spaces. Checking
      // every whitespace-separated token is coarse but fails safe: a fragment
      // of a legitimate relative path is never absolute and never `..`.
      for (const token of line.slice(11).split(/\s+/)) {
        if (token) assertSafePatchPath(token);
      }
    }
  }
}

async function applyGitPatch(root, patchText, signal, ctx) {
  validatePatchPaths(patchText);
  const home = path.join(root, '.agent-home');
  fs.mkdirSync(home, { recursive: true });
  const identity = externalSpawnIdentity(ctx, root);
  const args = ['apply', '--no-index', '--whitespace=nowarn', '-'];
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  if (identity?.isolated) {
    const remote = await executeInExecutor({
      workspace: root, uid: identity.uid, gid: identity.gid, file: 'git', args, env, stdin: String(patchText || ''), timeoutMs: DEFAULT_TOOL_TIMEOUT_MS, signal,
    });
    if (remote) {
      if (Number(remote.code) === 0) return { stdout: truncate(remote.stdout), stderr: truncate(remote.stderr) };
      throw new Error(truncate(remote.stderr || remote.stdout || `git apply exited ${remote.code}`));
    }
  }
  const launch = sandboxCommand(identity, 'git', args);
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], ...launch.options });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout = truncate(stdout + d.toString('utf8')); });
    child.stderr.on('data', (d) => { stderr = truncate(stderr + d.toString('utf8')); });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => { signal?.removeEventListener('abort', abort); reject(err); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `git apply exited ${code}`));
    });
    child.stdin.end(String(patchText || ''));
  });
}

function environmentCommandStatus(root, commands) {
  const env = managedShellEnvironment(root, { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' });
  const paths = String(env.PATH || '').split(':').filter(Boolean);
  const out = {};
  for (const raw of Array.isArray(commands) ? commands.slice(0, 40) : []) {
    const command = String(raw || '').trim();
    if (!/^[A-Za-z0-9._+-]{1,80}$/.test(command)) continue;
    let found = null;
    for (const dir of paths) {
      const candidate = path.join(dir, command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) { found = candidate; break; }
      } catch { /* unavailable */ }
    }
    out[command] = found;
  }
  return out;
}

function missingCommandHint(result) {
  if (result?.code !== 127) return null;
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const matches = [...text.matchAll(/(?:^|\n)(?:[^\n]*?:\s*)?([A-Za-z0-9._+-]+): command not found\b/gm)];
  for (const match of matches) {
    const hint = suggestToolchainForCommand(match[1]);
    if (hint) return hint;
  }
  return null;
}

export async function executeTool(name, input, ctx) {
  const tool = String(name || '').toLowerCase();
  const root = ctx.workspace;
  if (tool === 'question') return { kind: 'question', questions: Array.isArray(input?.questions) ? input.questions : [] };

  if (tool === 'read') {
    const requestedPath = String(input?.path || '');
    assertAgentReadablePath(requestedPath);
    const full = safeWorkspacePath(root, requestedPath, { allowMissing: false });
    const offset = Math.max(0, Number(input?.offset) || 0);
    const limit = Math.min(Math.max(1, Number(input?.limit) || 500), 4000);
    const body = await readUtf8Window(full, offset, limit);
    return { output: body, title: rel(root, full), metadata: { offset, limit } };
  }

  if (tool === 'list') {
    const full = safeWorkspacePath(root, input?.path || '.', { allowMissing: false });
    const st = fs.statSync(full);
    if (!st.isDirectory()) return { output: rel(root, full), title: rel(root, full) };
    const out = [];
    walk(root, full, Math.min(Math.max(Number(input?.depth) || 2, 1), 6), out);
    return { output: out.map((x) => `${x.type === 'directory' ? 'd' : 'f'} ${x.path}`).join('\n'), title: rel(root, full) || '.' };
  }

  if (tool === 'glob') {
    const start = safeWorkspacePath(root, input?.path || '.', { allowMissing: false });
    const all = [];
    walk(root, start, 10, all);
    const rx = globRegex(String(input?.pattern || '**/*'));
    const baseRel = rel(root, start);
    const hits = all.filter((x) => rx.test(baseRel ? path.posix.relative(baseRel, x.path) : x.path)).map((x) => x.path).slice(0, 1000);
    return { output: hits.join('\n'), title: String(input?.pattern || '') };
  }

  if (tool === 'grep') {
    const start = safeWorkspacePath(root, input?.path || '.', { allowMissing: false });
    const all = [];
    const st = fs.statSync(start);
    if (st.isDirectory()) walk(root, start, 10, all); else all.push({ path: rel(root, start), type: 'file' });
    const max = Math.min(Math.max(Number(input?.maxResults) || 100, 1), 300);
    const query = String(input?.query || '');
    if (query.length > MAX_PATTERN_CHARS) throw new Error(`grep: query is too long (max ${MAX_PATTERN_CHARS} characters)`);

    const files = [];
    for (const item of all) {
      if (item.type !== 'file' || isSensitiveWorkspacePath(item.path)) continue;
      try { files.push({ path: item.path, full: safeWorkspacePath(root, item.path, { allowMissing: false }) }); } catch { /* unreadable */ }
    }

    const regex = Boolean(input?.regex);
    const hits = await grepInWorker(files, query, max, GREP_TIMEOUT_MS, regex);
    return {
      output: hits.join('\n'),
      title: query,
      metadata: { matches: hits.length, mode: regex ? 'regex' : 'literal' },
    };
  }

  if (tool === 'repo_map') {
    const scope = safeWorkspacePath(root, input?.path || '.', { allowMissing: false });
    const map = buildRepoMap(root, scope, {
      maxFiles: Math.min(Math.max(Number(input?.maxFiles) || 2500, 100), 8000),
      maxSymbolsPerFile: Math.min(Math.max(Number(input?.maxSymbolsPerFile) || 8, 0), 20),
    });
    return {
      output: formatRepoMap(map),
      title: `Repository map: ${rel(root, scope) || '.'}`,
      metadata: { repoMap: { scope: map.scope, fileCount: map.fileCount, truncated: map.truncated } },
    };
  }

  if (tool === 'write') {
    const full = safeWorkspacePath(root, input?.path, { allowMissing: true });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(input?.content ?? ''), 'utf8');
    if (ctx.sessionId) syncSandboxOwnership(ctx.sessionId, root, full);
    return { output: `Wrote ${Buffer.byteLength(String(input?.content ?? ''))} bytes to ${rel(root, full)}`, title: rel(root, full), mutatedPaths: [rel(root, full)] };
  }

  if (tool === 'edit') {
    const full = safeWorkspacePath(root, input?.path, { allowMissing: false });
    const before = readUtf8(full);
    const oldText = String(input?.oldText ?? '');
    if (!oldText) throw new Error('oldText must not be empty');
    if (!before.includes(oldText)) throw new Error('oldText was not found in file');
    const after = input?.all ? before.split(oldText).join(String(input?.newText ?? '')) : before.replace(oldText, String(input?.newText ?? ''));
    fs.writeFileSync(full, after, 'utf8');
    if (ctx.sessionId) syncSandboxOwnership(ctx.sessionId, root, full);
    return { output: `Edited ${rel(root, full)}`, title: rel(root, full), mutatedPaths: [rel(root, full)] };
  }

  if (tool === 'apply_patch') {
    const patchText = String(input?.patch || '');
    if (!patchText.trim()) throw new Error('patch must not be empty');
    const result = await applyGitPatch(root, patchText, ctx.signal, ctx);
    return { output: result.stderr || result.stdout || 'Patch applied', title: 'Applied patch', mutatedPaths: ['.'] };
  }

  if (tool === 'todowrite') {
    const todos = Array.isArray(input?.todos) ? input.todos.slice(0, 30) : [];
    const lines = todos.map((todo, i) => `${i + 1}. [${todo.status || 'pending'}] ${String(todo.content || '')}`);
    return { output: lines.join('\n') || 'Todo list cleared', title: 'Updated todos', metadata: { todos } };
  }

  if (tool === 'task') throw new Error('task is executed by the agent runtime, not the generic tool executor');

  if (tool === 'ensure_environment') {
    if (executorRequired() && process.env.Z_AGENT_ALLOW_NETWORKED_INSTALLERS !== '1') throw Object.assign(new Error('ensure_environment is disabled in hardened executor mode. Bake dependencies into the image or provision them through an operator-controlled workflow.'), { statusCode: 403, code: 'NETWORKED_INSTALLER_DISABLED' });
    if (agentNetworkPolicy() !== 'public') {
      throw Object.assign(new Error('ensure_environment is disabled when Z_AGENT_NETWORK_POLICY is allowlist/off because its package/toolchain installers can contact multiple external registries. Provision dependencies outside the autonomous turn or use public policy in a trusted environment.'), { statusCode: 403, code: 'AGENT_NETWORK_BLOCKED' });
    }
    const kind = String(input?.kind || '').trim().toLowerCase();
    const plan = BASE_ENVIRONMENT_KINDS.includes(kind)
      ? prepareEnvironmentRequirement(root, input || {})
      : prepareToolchainRequirement(root, input || {});
    const result = await execBash(root, plan.script, Number(input?.timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, ctx.signal, ctx);
    const body = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.code !== 0) throw new Error(body || `${plan.title} provisioning exited ${result.code}`);
    const manifest = commitEnvironmentRequirement(root, plan);
    if (ctx.sessionId) syncSandboxOwnership(ctx.sessionId, root, path.join(root, '.agent-home'));
    return {
      output: [body || `${plan.title} ready`, '', 'Managed environment:', JSON.stringify(describeManagedEnvironment(root), null, 2)].join('\n'),
      title: plan.title,
      metadata: { environment: { kind: plan.kind, installed: manifest.installed } },
    };
  }

  if (tool === 'environment_status') {
    const environment = describeManagedEnvironment(root);
    const commands = environmentCommandStatus(root, input?.commands || []);
    return {
      output: JSON.stringify({ environment, commands }, null, 2),
      title: 'Environment status',
      metadata: { environmentStatus: true },
    };
  }

  if (tool === 'bash') {
    const command = String(input?.command || '');
    assertShellCommandAllowed(command);
    const result = await execBash(root, command, Number(input?.timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, ctx.signal, ctx);
    const hint = missingCommandHint(result);
    const body = [
      `exit=${result.code}`,
      result.stdout && `stdout:\n${result.stdout}`,
      result.stderr && `stderr:\n${result.stderr}`,
      hint && `Environment hint: command "${hint.command}" is missing. Use ensure_environment with kind="${hint.kind}" and then continue the original task; lack of sudo/root is not a reason to stop.`,
    ].filter(Boolean).join('\n');
    return {
      output: body,
      title: command,
      mutatedPaths: classifyBash(command) === 'read_only' ? [] : ['.'],
      metadata: { exit: result.code, shellNetworkPolicy: shellNetworkPolicy(), ...(hint ? { environmentHint: hint } : {}) },
    };
  }

  if (tool === 'websearch') {
    assertAgentNetworkHost('api.search.brave.com', { tool: 'websearch' });
    const apiKey = process.env.BRAVE_SEARCH_API_KEY || '';
    if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY is not configured on the runtime');
    const query = String(input?.query || '').trim();
    if (!query) throw new Error('query must not be empty');
    const count = Math.min(Math.max(Number(input?.count) || 5, 1), 10);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    const res = await safeExternalRequest(url.toString(), {
      headers: { accept: 'application/json', 'x-subscription-token': apiKey, 'user-agent': 'Z-Agent-Native/1.0' },
      signal: ctx.signal,
      maxBytes: 2 * 1024 * 1024,
    });
    const text = res.text;
    if (res.status < 200 || res.status >= 300) throw new Error(`Brave Search HTTP ${res.status}: ${text.slice(0, 500)}`);
    let body; try { body = JSON.parse(text); } catch { throw new Error('Brave Search returned invalid JSON'); }
    const rows = (body?.web?.results || []).slice(0, count).map((row, i) => `${i + 1}. ${row.title || row.url}\n${row.url}\n${row.description || ''}`);
    return { output: rows.join('\n\n'), title: query };
  }

  if (tool === 'webfetch') {
    assertAgentNetworkUrl(input?.url, { tool: 'webfetch' });
    const maxChars = Math.min(Math.max(Number(input?.maxChars) || 50000, 1000), 200000);
    // safeExternalRequest reuses the exact address that passed the SSRF check,
    // which closes the DNS-rebinding window between validation and connect.
    const res = await safeExternalRequest(input?.url, {
      headers: { 'user-agent': 'Z-Agent-Native/1.0', accept: 'text/plain,text/html,application/json;q=0.9,*/*;q=0.5' },
      signal: ctx.signal,
      maxBytes: Math.max(maxChars * 4, 1024 * 1024),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 500)}`);
    return { output: res.text.slice(0, maxChars), title: String(res.url) };
  }

  if (tool === 'git') {
    const result = await executeGitTool({
      root,
      identity: externalSpawnIdentity(ctx, root),
      input: input || {},
      signal: ctx.signal,
    });
    // Only history-writing actions touch the working tree. Reporting reads as
    // mutations would make every git status dirty the workspace snapshot.
    const writes = ['commit', 'create_branch'].includes(String(input?.action || '').toLowerCase());
    return writes ? { ...result, mutatedPaths: ['.'] } : result;
  }

  if (tool === 'run_tests') {
    const plan = buildTestCommand(root, input || {});
    const result = await execBash(root, plan.command, Number(input?.timeoutMs) || 900_000, ctx.signal, ctx);
    const report = formatTestReport({
      command: plan.command,
      framework: plan.framework,
      source: plan.source,
      exitCode: result.code,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
    });
    return {
      output: report.text,
      title: plan.command,
      // Test runs routinely write coverage, snapshots, and build caches.
      mutatedPaths: ['.'],
      metadata: {
        tests: {
          command: plan.command,
          framework: plan.framework,
          exit: result.code,
          totals: report.totals,
          failures: report.failures.slice(0, 40),
        },
      },
    };
  }

  if (tool === 'diagnostics') {
    const plans = planDiagnostics(root, input || {});
    const runs = [];
    for (const plan of plans) {
      const result = await execBash(root, plan.command, Number(input?.timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, ctx.signal, ctx);
      runs.push({
        ...plan,
        exitCode: result.code,
        output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
      });
    }
    const report = formatDiagnosticsReport(runs);
    return {
      output: report.text,
      title: plans.map((plan) => plan.kind).join(' + '),
      metadata: {
        diagnostics: {
          ok: report.ok,
          errorCount: report.errorCount,
          warningCount: report.warningCount,
          commands: plans.map((plan) => plan.command),
        },
      },
    };
  }

  if (tool === 'browser') {
    const action = String(input?.action || '').trim().toLowerCase();
    // Reject browser use before resolving/creating any session sandbox. The
    // browser egress proxy independently enforces the same policy, but this
    // early gate keeps policy=off side-effect free and deterministic.
    if (agentNetworkPolicy() === 'off' && action !== 'close') {
      throw Object.assign(new Error('browser is disabled by Z_AGENT_NETWORK_POLICY=off.'), { statusCode: 403, code: 'AGENT_NETWORK_BLOCKED' });
    }
    if (action === 'open') assertAgentNetworkUrl(input?.url, { tool: 'browser' });
    const identity = sandboxIdentity(ctx.sessionId);
    return executeBrowserTool({ sessionId: ctx.sessionId, uid: identity?.isolated ? identity.uid : null, input: input || {}, signal: ctx.signal });
  }

  throw new Error(`Unknown tool: ${name}`);
}

export function toolOutputText(result) {
  return truncate(textResult(result?.output ?? result));
}
