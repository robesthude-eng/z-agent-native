import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { DEFAULT_TOOL_TIMEOUT_MS, GREP_TIMEOUT_MS } from '../config.mjs';
import { safeWorkspacePath } from '../security.mjs';
import { ensureManagedHome, syncSandboxOwnership } from '../sandbox.mjs';
import { executeInExecutor, executorRequired } from '../executor-client.mjs';
import { assertAgentReadablePath, isSensitiveWorkspacePath } from '../workspace-policy.mjs';
import { truncate } from './dispatcher.mjs';
import { externalSpawnIdentity } from './shell.mjs';
import { sandboxCommand } from '../sandbox.mjs';
import { spawn } from 'node:child_process';

export const MAX_READ_BYTES = 512 * 1024;
export const MAX_TOOL_OUTPUT = 512 * 1024;
export const MAX_MATCH_LINE = 2000;
export const MAX_PATTERN_CHARS = 1000;
export const MAX_WALK_ENTRIES = 10_000;
export const IGNORED_WALK_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.agent-home']);

function rel(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

export function isBinaryFile(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(1024);
    const bytes = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytes; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function walk(root, start, depth, out, baseDepth = 0) {
  if (baseDepth > depth || out.length >= MAX_WALK_ENTRIES) return;
  let entries;
  try { entries = fs.readdirSync(start, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_WALK_ENTRIES) break;
    if (entry.isDirectory() && IGNORED_WALK_DIRS.has(entry.name)) continue;
    const full = path.join(start, entry.name);
    const relative = rel(root, full);
    out.push({ path: relative, type: entry.isDirectory() ? 'directory' : 'file' });
    if (entry.isDirectory()) walk(root, full, depth, out, baseDepth + 1);
  }
}

export function globRegex(glob) {
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
    else s += ch.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}

export function readUtf8(full) {
  const buf = fs.readFileSync(full);
  if (buf.length > MAX_READ_BYTES) throw new Error(`File is too large for whole-file editing (${buf.length} bytes); use read with offset/limit to inspect it`);
  if (buf.includes(0)) throw new Error('Binary file: use bash or a specialized tool instead');
  return buf.toString('utf8');
}

export async function readUtf8Window(full, offset, limit) {
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

export const readLinesWindow = readUtf8Window;

export async function grepInWorker(files, pattern, max, timeoutMs, regex) {
  const workerUrl = new URL('../grep-worker.mjs', import.meta.url);
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

function assertSafePatchPath(raw) {
  let value = String(raw || '').trim().split('\t')[0];
  if (!value || value === '/dev/null') return;
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch { throw new Error(`Unsafe patch path: ${raw}`); }
  }
  value = value.replace(/^[ab]\//, '');
  if (path.isAbsolute(value) || value.split(/[\\/]+/).includes('..') || value.includes('\0')) throw new Error(`Unsafe patch path: ${value}`);
}

function validatePatchPaths(patchText) {
  for (const line of String(patchText || '').split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) assertSafePatchPath(line.slice(4));
    else if (line.startsWith('rename from ')) assertSafePatchPath(line.slice(12));
    else if (line.startsWith('rename to ')) assertSafePatchPath(line.slice(10));
    else if (line.startsWith('copy from ')) assertSafePatchPath(line.slice(10));
    else if (line.startsWith('copy to ')) assertSafePatchPath(line.slice(8));
    else if (line.startsWith('diff --git ')) {
      for (const token of line.slice(11).split(/\s+/)) {
        if (token) assertSafePatchPath(token);
      }
    }
  }
}

export async function applyGitPatch(root, patchText, signal, ctx) {
  validatePatchPaths(patchText);
  const identity = externalSpawnIdentity(ctx, root);
  const home = ensureManagedHome(ctx?.sessionId, root);
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

export const executeApplyPatch = applyGitPatch;

export async function executeReadFile(root, input) {
  const requestedPath = String(input?.path || '');
  assertAgentReadablePath(requestedPath);
  const full = safeWorkspacePath(root, requestedPath, { allowMissing: false });
  const offset = Math.max(0, Number(input?.offset) || 0);
  const limit = Math.min(Math.max(1, Number(input?.limit) || 500), 4000);
  const body = await readUtf8Window(full, offset, limit);
  return { output: body, title: rel(root, full), metadata: { offset, limit } };
}

export function executeListFiles(root, input) {
  const full = safeWorkspacePath(root, input?.path || '.', { allowMissing: false });
  const st = fs.statSync(full);
  if (!st.isDirectory()) return { output: rel(root, full), title: rel(root, full) };
  const out = [];
  walk(root, full, Math.min(Math.max(Number(input?.depth) || 2, 1), 6), out);
  return { output: out.map((x) => `${x.type === 'directory' ? 'd' : 'f'} ${x.path}`).join('\n'), title: rel(root, full) || '.' };
}

export function executeGlobFiles(root, input) {
  const start = safeWorkspacePath(root, input?.path || '.', { allowMissing: false });
  const all = [];
  walk(root, start, 10, all);
  const rx = globRegex(String(input?.pattern || '**/*'));
  const baseRel = rel(root, start);
  const hits = all.filter((x) => rx.test(baseRel ? path.posix.relative(baseRel, x.path) : x.path)).map((x) => x.path).slice(0, 1000);
  return { output: hits.join('\n'), title: String(input?.pattern || '') };
}

export async function executeGrepFiles(root, input) {
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
    try { files.push({ path: item.path, full: safeWorkspacePath(root, item.path, { allowMissing: false }) }); } catch {}
  }

  const regex = Boolean(input?.regex);
  const hits = await grepInWorker(files, query, max, GREP_TIMEOUT_MS, regex);
  return {
    output: hits.join('\n'),
    title: query,
    metadata: { matches: hits.length, mode: regex ? 'regex' : 'literal' },
  };
}

export function executeWriteFile(root, input, sessionId = null) {
  const full = safeWorkspacePath(root, input?.path, { allowMissing: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, String(input?.content ?? ''), 'utf8');
  if (sessionId) syncSandboxOwnership(sessionId, root, full);
  return { output: `Wrote ${Buffer.byteLength(String(input?.content ?? ''))} bytes to ${rel(root, full)}`, title: rel(root, full), mutatedPaths: [rel(root, full)] };
}

export const performWorkspaceWrite = executeWriteFile;

export function executeEditFile(root, input, sessionId = null) {
  const full = safeWorkspacePath(root, input?.path, { allowMissing: false });
  const before = readUtf8(full);
  const oldText = String(input?.oldText ?? '');
  if (!oldText) throw new Error('oldText must not be empty');
  if (!before.includes(oldText)) throw new Error('oldText was not found in file');
  const after = input?.all ? before.split(oldText).join(String(input?.newText ?? '')) : before.replace(oldText, String(input?.newText ?? ''));
  fs.writeFileSync(full, after, 'utf8');
  if (sessionId) syncSandboxOwnership(sessionId, root, full);
  return { output: `Edited ${rel(root, full)}`, title: rel(root, full), mutatedPaths: [rel(root, full)] };
}

export const performWorkspaceEdit = executeEditFile;
