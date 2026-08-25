import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { GREP_TIMEOUT_MS } from '../config.mjs';
import { safeWorkspacePath } from '../security.mjs';
import { syncSandboxOwnership } from '../sandbox.mjs';
import { executeInExecutor, executorRequired } from '../executor-client.mjs';
import { assertAgentReadablePath, isSensitiveWorkspacePath } from '../workspace-policy.mjs';

export const FILESYSTEM_TOOL_NAMES = [
  'read',
  'list',
  'glob',
  'grep',
  'write',
  'edit',
  'apply_patch',
];

export function isFilesystemTool(name) {
  return FILESYSTEM_TOOL_NAMES.includes(name);
}

export function registerFilesystemTools(registry, handlers = {}) {
  for (const name of FILESYSTEM_TOOL_NAMES) {
    if (typeof handlers[name] === 'function') {
      if (registry && typeof registry.set === 'function') {
        registry.set(name, handlers[name]);
      } else if (registry && typeof registry.registerTool === 'function') {
        registry.registerTool(name, handlers[name]);
      }
    }
  }
  return registry;
}

export const MAX_READ_BYTES = 512 * 1024;
export const MAX_TOOL_OUTPUT = 512 * 1024;
export const MAX_MATCH_LINE = 2000;
export const MAX_PATTERN_CHARS = 1000;
export const MAX_WALK_ENTRIES = 10_000;
export const IGNORED_WALK_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.agent-home']);

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

export function walk(dir, root, maxDepth, currentDepth = 0, entries = [], visited = new Set()) {
  if (entries.length >= MAX_WALK_ENTRIES || currentDepth > maxDepth) return entries;
  let real = null;
  try {
    real = fs.realpathSync(dir);
    if (visited.has(real)) return entries;
    visited.add(real);
  } catch {
    return entries;
  }
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const item of items) {
    if (entries.length >= MAX_WALK_ENTRIES) break;
    const abs = path.join(dir, item.name);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..')) continue;
    if (item.isDirectory()) {
      if (IGNORED_WALK_DIRS.has(item.name)) continue;
      entries.push(`${rel}/`);
      walk(abs, root, maxDepth, currentDepth + 1, entries, visited);
    } else {
      entries.push(rel);
    }
  }
  return entries;
}

export async function readLinesWindow(absPath, offset, limit) {
  return new Promise((resolve, reject) => {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (e) {
      return reject(e);
    }
    if (stat.size > 10 * 1024 * 1024 && offset === 0 && limit >= 1000) {
      return reject(new Error(`File is large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Read in smaller windows with offset and limit.`));
    }
    const stream = fs.createReadStream(absPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const lines = [];
    let lineNo = 0;
    let bytes = 0;
    let truncatedByBytes = false;

    rl.on('line', (line) => {
      lineNo++;
      if (lineNo <= offset) return;
      if (lines.length >= limit) {
        rl.close();
        stream.destroy();
        return;
      }
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > MAX_READ_BYTES) {
        truncatedByBytes = true;
        rl.close();
        stream.destroy();
        return;
      }
      lines.push(`${String(lineNo).padStart(6, ' ')} | ${line}`);
    });

    rl.on('close', () => {
      if (lines.length === 0 && lineNo <= offset) {
        resolve(`(File has ${lineNo} lines; offset ${offset} is beyond the end of the file)`);
      } else {
        const out = lines.join('\n');
        resolve(truncatedByBytes ? `${out}\n\n(Output truncated at 512 KB limit; specify offset/limit to read more)` : out);
      }
    });

    rl.on('error', reject);
    stream.on('error', reject);
  });
}

export function performWorkspaceWrite(root, target, content, sessionId = null) {
  const abs = safeWorkspacePath(root, target);
  if (isSensitiveWorkspacePath(target)) {
    throw Object.assign(new Error(`Access denied: "${target}" is a blocked sensitive workspace path.`), {
      statusCode: 403,
      code: 'SENSITIVE_FILE_BLOCKED',
    });
  }
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const isNew = !fs.existsSync(abs);
  fs.writeFileSync(abs, String(content ?? ''), 'utf8');
  if (sessionId) syncSandboxOwnership(sessionId, root, abs);
  return { abs, isNew, bytes: Buffer.byteLength(content, 'utf8') };
}

export function performWorkspaceEdit(root, target, oldText, newText, replaceAll = false, sessionId = null) {
  const abs = safeWorkspacePath(root, target);
  if (isSensitiveWorkspacePath(target)) {
    throw Object.assign(new Error(`Access denied: "${target}" is a blocked sensitive workspace path.`), {
      statusCode: 403,
      code: 'SENSITIVE_FILE_BLOCKED',
    });
  }
  assertAgentReadablePath(target, { tool: 'edit' });
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${target}`);
  const current = fs.readFileSync(abs, 'utf8');
  if (!oldText) throw new Error('oldText must not be empty');
  if (!current.includes(oldText)) {
    const trimmedOld = oldText.trim();
    if (trimmedOld && current.includes(trimmedOld)) {
      throw new Error(`oldText not found exactly as provided, but a whitespace-trimmed version exists. Match exact indentation and newlines.`);
    }
    throw new Error(`oldText not found in ${target}`);
  }
  if (!replaceAll) {
    const first = current.indexOf(oldText);
    const second = current.indexOf(oldText, first + oldText.length);
    if (second !== -1) {
      throw new Error(`oldText matches multiple times in ${target}. Make oldText more specific or pass all=true.`);
    }
  }
  const next = replaceAll ? current.replaceAll(oldText, newText) : current.replace(oldText, newText);
  fs.writeFileSync(abs, next, 'utf8');
  if (sessionId) syncSandboxOwnership(sessionId, root, abs);
  const count = replaceAll ? current.split(oldText).length - 1 : 1;
  return { abs, count, bytes: Buffer.byteLength(next, 'utf8') };
}

export async function executeReadFile(root, input) {
  const rel = String(input?.path || '');
  assertAgentReadablePath(rel, { tool: 'read' });
  const abs = safeWorkspacePath(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${rel}`);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`${rel} is a directory; use list instead`);
  if (isBinaryFile(abs)) return { output: `[Binary file: ${stat.size} bytes]`, title: rel };
  const offset = Number(input?.offset) || 0;
  const limit = Math.min(Math.max(Number(input?.limit) || 200, 1), 4000);
  const body = await readLinesWindow(abs, offset, limit);
  return { output: body, title: rel, metadata: { totalLines: body.split('\n').length } };
}

export function executeListFiles(root, input) {
  const rel = String(input?.path || '.');
  assertAgentReadablePath(rel, { tool: 'list' });
  const abs = safeWorkspacePath(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${rel}`);
  const depth = Math.min(Math.max(Number(input?.depth) || 2, 1), 6);
  const entries = walk(abs, root, depth);
  return { output: entries.length ? entries.join('\n') : '(Empty directory)', title: rel };
}

export function executeGlobFiles(root, input) {
  const pat = String(input?.pattern || '');
  const rel = String(input?.path || '.');
  assertAgentReadablePath(rel, { tool: 'glob' });
  const abs = safeWorkspacePath(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${rel}`);
  const entries = walk(abs, root, 8);
  const regex = globToRegExp(pat);
  const matches = entries.filter((e) => regex.test(e) || regex.test(path.basename(e)));
  return { output: matches.length ? matches.join('\n') : '(No matches)', title: pat };
}

export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '.*')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`);
}

export async function executeGrepFiles(root, input, ctx = {}) {
  const query = String(input?.query || '');
  if (!query) throw new Error('query must not be empty');
  if (query.length > MAX_PATTERN_CHARS) throw new Error(`Query exceeds limit of ${MAX_PATTERN_CHARS} characters`);
  const rel = String(input?.path || '.');
  assertAgentReadablePath(rel, { tool: 'grep' });
  const abs = safeWorkspacePath(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${rel}`);
  const isRegex = Boolean(input?.regex);
  const maxResults = Math.min(Math.max(Number(input?.maxResults) || 100, 1), 300);
  const results = await runGrepInWorker(root, abs, query, isRegex, maxResults, ctx.signal);
  const formatted = formatGrepMatches(results, maxResults);
  return { output: formatted, title: query };
}

export function formatGrepMatches(results, maxResults) {
  if (!results.length) return '(No matches)';
  const lines = [];
  for (const r of results) {
    const truncatedLine = r.line.length > MAX_MATCH_LINE ? `${r.line.slice(0, MAX_MATCH_LINE)}... [line truncated]` : r.line;
    lines.push(`${r.path}:${r.lineNo}: ${truncatedLine}`);
  }
  if (results.length >= maxResults) {
    lines.push(`\n(Search stopped at max ${maxResults} results. Use a more specific query/path or pagination.)`);
  }
  return lines.join('\n');
}

export function runGrepInWorker(root, startDir, query, isRegex, maxResults, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Operation aborted'));
    const workerScript = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const path = require('node:path');
      const readline = require('node:readline');

      const { root, startDir, query, isRegex, maxResults } = workerData;
      let regex;
      try {
        regex = isRegex ? new RegExp(query, 'g') : null;
      } catch (e) {
        parentPort.postMessage({ error: 'Invalid regular expression: ' + e.message });
        process.exit(0);
      }

      const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.agent-home']);
      const results = [];
      let stopped = false;

      function isBinary(abs) {
        try {
          const fd = fs.openSync(abs, 'r');
          const buf = Buffer.alloc(512);
          const bytes = fs.readSync(fd, buf, 0, 512, 0);
          fs.closeSync(fd);
          for (let i = 0; i < bytes; i++) { if (buf[i] === 0) return true; }
        } catch { return false; }
        return false;
      }

      async function grepFile(abs, rel) {
        if (stopped || isBinary(abs)) return;
        return new Promise((res) => {
          const rl = readline.createInterface({
            input: fs.createReadStream(abs, { encoding: 'utf8', highWaterMark: 64 * 1024 }),
            crlfDelay: Infinity,
          });
          let lineNo = 0;
          rl.on('line', (line) => {
            lineNo++;
            if (stopped) { rl.close(); return; }
            let hit = false;
            if (isRegex) {
              regex.lastIndex = 0;
              hit = regex.test(line);
            } else {
              hit = line.includes(query);
            }
            if (hit) {
              results.push({ path: rel, lineNo, line });
              if (results.length >= maxResults) {
                stopped = true;
                rl.close();
              }
            }
          });
          rl.on('close', res);
          rl.on('error', res);
        });
      }

      async function search(dir) {
        if (stopped) return;
        let items = [];
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
          if (stopped) break;
          const abs = path.join(dir, item.name);
          const rel = path.relative(root, abs);
          if (item.isDirectory()) {
            if (IGNORED.has(item.name)) continue;
            await search(abs);
          } else if (item.isFile()) {
            await grepFile(abs, rel);
          }
        }
      }

      (async () => {
        try {
          const stat = fs.statSync(startDir);
          if (stat.isDirectory()) await search(startDir);
          else await grepFile(startDir, path.relative(root, startDir));
          parentPort.postMessage({ results });
        } catch (e) {
          parentPort.postMessage({ error: e.message });
        }
      })();
    `;

    const worker = new Worker(workerScript, {
      eval: true,
      workerData: { root, startDir, query, isRegex, maxResults },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Grep timed out after ${GREP_TIMEOUT_MS / 1000}s. Restrict the path or use a more specific query.`));
    }, GREP_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error('Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (msg) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.results);
    });

    worker.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

export function executeWriteFile(root, input, sessionId = null) {
  const rel = String(input?.path || '');
  const content = String(input?.content ?? '');
  const { isNew, bytes } = performWorkspaceWrite(root, rel, content, sessionId);
  return {
    output: `${isNew ? 'Created' : 'Updated'} ${rel} (${bytes} bytes)`,
    title: rel,
    mutatedPaths: [rel],
  };
}

export function executeEditFile(root, input, sessionId = null) {
  const rel = String(input?.path || '');
  const oldText = String(input?.oldText ?? '');
  const newText = String(input?.newText ?? '');
  const replaceAll = Boolean(input?.all);
  const { count, bytes } = performWorkspaceEdit(root, rel, oldText, newText, replaceAll, sessionId);
  return {
    output: `Updated ${rel}: replaced ${count} occurrence(s) (${bytes} bytes total)`,
    title: rel,
    mutatedPaths: [rel],
  };
}

export async function executeApplyPatch(root, patch, sessionId, signal, execBash) {
  const trimmed = String(patch || '').trim();
  if (!trimmed) throw new Error('Patch is empty');
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const p = line.slice(4).trim().replace(/^[ab]\//, '');
      if (p && p !== '/dev/null') {
        safeWorkspacePath(root, p);
        if (isSensitiveWorkspacePath(p)) {
          throw Object.assign(new Error(`Access denied: "${p}" in patch is a blocked sensitive workspace path.`), {
            statusCode: 403,
            code: 'SENSITIVE_FILE_BLOCKED',
          });
        }
      }
    }
  }

  let code;
  let stdout;
  let stderr;

  if (executorRequired()) {
    const res = await executeInExecutor(root, 'git apply --whitespace=nowarn -', {
      timeoutMs: 30_000,
      signal,
      stdin: trimmed,
      sessionId,
    });
    code = res.code;
    stdout = res.stdout;
    stderr = res.stderr;
  } else {
    const res = await execBash(root, 'git apply --whitespace=nowarn -', 30_000, signal, { stdin: trimmed, sessionId });
    code = res.code;
    stdout = res.stdout;
    stderr = res.stderr;
  }

  if (code !== 0) {
    const err = (stderr || stdout || '').trim();
    throw new Error(err ? `Patch failed:\n${err}` : `git apply failed with exit code ${code}`);
  }
  if (sessionId) syncSandboxOwnership(sessionId, root);
  return { output: stdout || 'Patch applied cleanly', title: 'apply_patch', mutatedPaths: ['.'] };
}
