import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from './security.mjs';

const MAX_DIFF_CHARS = 240_000;
const MAX_UNTRACKED_PREVIEW_BYTES = 256 * 1024;

// git inherits whatever it is given, and the server process environment holds
// provider API keys, the master-key override and deploy secrets. A hook, an
// alias or a credential helper picked up from the workspace would see all of
// it. Pass only what git actually needs, and disable the config sources and
// prompts that could reach outside the repository.
const GIT_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];

function defaultGitEnv() {
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  return env;
}

function gitResult(root, args, options = {}) {
  const result = spawnSync(options.spawnFile || 'git', [
    ...(options.spawnArgsPrefix || []),
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: Number(options.timeoutMs) || 8_000,
    ...(options.spawnOptions || {}),
    env: options.env || defaultGitEnv(),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function gitOrThrow(root, args, options = {}) {
  const result = gitResult(root, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `git exited ${result.status}`).trim();
    throw new Error(detail);
  }
  return result.stdout;
}

function statusKind(code) {
  if (code.includes('?')) return 'untracked';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A') || code.includes('C')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

/** Parse `git status --porcelain=v1 -z`. Rename/copy records contain a second NUL path. */
export function parsePorcelainZ(text) {
  const tokens = String(text || '').split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const record = tokens[i];
    if (!record) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;
    const kind = statusKind(code);
    const row = { path: filePath, status: kind, code };
    if ((code.includes('R') || code.includes('C')) && tokens[i + 1]) {
      // With -z, Git emits destination first and source second.
      row.originalPath = tokens[i + 1];
      i += 1;
    }
    rows.push(row);
  }
  return rows;
}

export function listGitChanges(root, options = {}) {
  const text = gitOrThrow(
    root,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    options,
  );
  return parsePorcelainZ(text);
}

function findChange(root, relativePath, options = {}) {
  const requested = String(relativePath || '').replace(/\\/g, '/');
  // Validates traversal/absolute paths before Git ever sees the value.
  safeWorkspacePath(root, requested, { allowMissing: true });
  const change = listGitChanges(root, options).find((row) => row.path === requested);
  if (!change) throw Object.assign(new Error('Файл больше не числится изменённым'), { statusCode: 409 });
  return change;
}

function boundedWithMarker(text, marker) {
  const value = String(text || '');
  const suffix = String(marker || '').endsWith('\n') ? String(marker) : `${marker}\n`;
  if (value.length + suffix.length <= MAX_DIFF_CHARS) {
    return `${value}${value && !value.endsWith('\n') ? '\n' : ''}${suffix}`;
  }

  // Reserve marker space before clipping so the explanation can never be cut
  // off by the same bound it describes. Prefer a complete diff line.
  const budget = Math.max(0, MAX_DIFF_CHARS - suffix.length - 1);
  let cut = value.lastIndexOf('\n', budget);
  if (cut < 0) cut = budget;
  const prefix = value.slice(0, cut + (value[cut] === '\n' ? 1 : 0));
  return `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}${suffix}`.slice(0, MAX_DIFF_CHARS);
}

function clipDiff(text) {
  const value = String(text || '');
  if (value.length <= MAX_DIFF_CHARS) return { patch: value, truncated: false };

  // Reserve a small fixed budget first, then compute the exact omitted count.
  const provisionalBudget = Math.max(0, MAX_DIFF_CHARS - 96);
  let cut = value.lastIndexOf('\n', provisionalBudget);
  if (cut < 0) cut = provisionalBudget;
  const omitted = Math.max(0, value.length - cut);
  const marker = `[diff truncated: ${omitted} chars omitted]`;
  return { patch: boundedWithMarker(value, marker), truncated: true };
}

function readFilePreview(full) {
  const stat = fs.statSync(full);
  if (!stat.isFile()) return { text: null, binary: true, truncated: false, omittedBytes: 0 };
  const length = Math.min(stat.size, MAX_UNTRACKED_PREVIEW_BYTES);
  const fd = fs.openSync(full, 'r');
  try {
    const buf = Buffer.alloc(length);
    const bytes = length ? fs.readSync(fd, buf, 0, length, 0) : 0;
    const sample = buf.subarray(0, bytes);
    if (sample.includes(0)) return { text: null, binary: true, truncated: stat.size > bytes, omittedBytes: Math.max(0, stat.size - bytes) };
    return {
      text: sample.toString('utf8'),
      binary: false,
      truncated: stat.size > bytes,
      omittedBytes: Math.max(0, stat.size - bytes),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function untrackedPatch(root, relativePath) {
  const full = safeWorkspacePath(root, relativePath, { allowMissing: false });
  const preview = readFilePreview(full);
  if (preview.binary || preview.text == null) return { patch: '', binary: true, truncated: preview.truncated };
  const lines = preview.text.split('\n');
  // Avoid a phantom final + line for the common trailing newline case.
  if (lines.at(-1) === '') lines.pop();
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ];
  const raw = [...header, ...lines.map((line) => `+${line}`)].join('\n') + '\n';

  if (preview.truncated) {
    const marker = `+[diff preview truncated: ${preview.omittedBytes} bytes omitted]`;
    return {
      patch: boundedWithMarker(raw, marker),
      binary: false,
      truncated: true,
    };
  }

  const clipped = clipDiff(raw);
  return { patch: clipped.patch, binary: false, truncated: clipped.truncated };
}

function patchStats(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+[diff preview truncated:')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

export function diffGitChange(root, relativePath, options = {}) {
  const change = findChange(root, relativePath, options);
  if (change.status === 'untracked') {
    const result = untrackedPatch(root, change.path);
    return { ...change, ...result, ...patchStats(result.patch) };
  }

  const args = ['diff', '--no-ext-diff', '--no-color', '--find-renames', 'HEAD', '--'];
  if (change.originalPath) args.push(change.originalPath);
  args.push(change.path);
  const result = gitResult(root, args, options);
  // A repository without HEAD cannot provide a meaningful tracked baseline.
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw Object.assign(new Error(detail || 'Не удалось построить diff относительно HEAD'), { statusCode: 409 });
  }
  const clipped = clipDiff(result.stdout);
  const binary = /Binary files .* differ|GIT binary patch/i.test(result.stdout);
  return { ...change, ...clipped, binary, ...patchStats(clipped.patch) };
}

function removeWorkspacePath(root, relativePath) {
  const full = safeWorkspacePath(root, relativePath, { allowMissing: true });
  fs.rmSync(full, { recursive: true, force: true });
}

export function revertGitChange(root, relativePath, options = {}) {
  const change = findChange(root, relativePath, options);

  if (change.status === 'untracked') {
    removeWorkspacePath(root, change.path);
  } else if (change.status === 'added') {
    // Remove the staged/index copy if present, then remove the new workspace file.
    gitResult(root, ['rm', '-f', '--cached', '--ignore-unmatch', '--', change.path], options);
    removeWorkspacePath(root, change.path);
  } else if (change.status === 'renamed') {
    if (!change.originalPath) throw Object.assign(new Error('Не удалось определить исходный путь переименованного файла'), { statusCode: 409 });
    // A staged rename is represented as old-path deletion + new-path addition.
    // Clear the destination from the index first, then restore the source from HEAD.
    gitResult(root, ['rm', '-f', '--cached', '--ignore-unmatch', '--', change.path], options);
    if (change.path !== change.originalPath) removeWorkspacePath(root, change.path);
    gitOrThrow(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', change.originalPath], options);
  } else {
    gitOrThrow(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', change.path], options);
  }

  return { ok: true, path: change.path, status: change.status, originalPath: change.originalPath || null };
}
