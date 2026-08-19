import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, WORKSPACES_DIR } from './config.mjs';
import { safeWorkspacePath } from './security.mjs';
import { prepareWorkspaceSandbox, sandboxCommand, syncSandboxOwnership } from './sandbox.mjs';
import { getTurn, listMessages, workspaceFor } from './store.mjs';
import { executeInExecutorSync } from './executor-client.mjs';

const RESULT_DIR = path.join(DATA_DIR, 'turn-results');
const MAX_RESULT_CHANGES = 4000;
const MAX_DIFF_CHARS = 240_000;
const MAX_RESTORE_BLOB_BYTES = 256 * 1024 * 1024;
const active = new Map();

function safeId(value, prefix) {
  const text = String(value || '');
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(text)) throw Object.assign(new Error('Invalid result identifier'), { statusCode: 400 });
  return text;
}

function sessionIdForWorkspace(root) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(WORKSPACES_DIR)) return null;
  const id = path.basename(resolved);
  return /^ses_[A-Za-z0-9]+$/.test(id) ? id : null;
}

function git(root, args, options = {}) {
  const sessionId = sessionIdForWorkspace(root);
  const identity = sessionId ? prepareWorkspaceSandbox(sessionId, root) : null;
  const gitArgs = [
    '-c', `safe.directory=${root}`,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    ...args,
  ];
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(root, '.agent-home'),
    USER: 'agent',
    LANG: process.env.LANG || 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...(options.env || {}),
  };
  // `git add` may execute repository-defined clean/process filters. Snapshot
  // capture is runtime-owned, but the repository is untrusted, so this one
  // porcelain operation must cross the same networkless executor boundary as
  // model-selected code. Pure object plumbing below cannot invoke repo code.
  if (args[0] === 'add' && identity?.isolated && options.encoding !== 'buffer') {
    const remote = executeInExecutorSync({ workspace: root, uid: identity.uid, gid: identity.gid, file: 'git', args: gitArgs, env, timeoutMs: Number(options.timeoutMs) || 30_000 });
    if (remote) {
      if (Number(remote.code) !== 0) throw Object.assign(new Error(String(remote.stderr || remote.stdout || `git exited ${remote.code}`).trim()), { statusCode: 409 });
      return String(remote.stdout || '');
    }
  }
  const launch = identity
    ? sandboxCommand(identity, 'git', gitArgs)
    : { file: 'git', args: gitArgs, options: {} };
  const result = spawnSync(launch.file, launch.args, {
    cwd: root,
    encoding: options.encoding === 'buffer' ? null : 'utf8',
    timeout: Number(options.timeoutMs) || 30_000,
    maxBuffer: Number(options.maxBuffer) || 8 * 1024 * 1024,
    env,
    ...launch.options,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr || '');
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout || '');
    throw Object.assign(new Error((stderr || stdout || `git exited ${result.status}`).trim()), { statusCode: 409 });
  }
  return result.stdout;
}

function tryGit(root, args, options = {}) {
  try { return git(root, args, options); } catch { return null; }
}

function resultDir(sessionId) {
  return path.join(RESULT_DIR, safeId(sessionId, 'ses'));
}

function activePath(sessionId) {
  return path.join(resultDir(sessionId), 'active.json');
}

function manifestPath(sessionId, messageId) {
  return path.join(resultDir(sessionId), `${safeId(messageId, 'msg')}.json`);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function refName(turnId, phase) {
  safeId(turnId, 'turn');
  if (!['before', 'after'].includes(phase)) throw new Error('Invalid snapshot phase');
  return `refs/z-agent/turn-results/${turnId}/${phase}`;
}

function currentIndexPath(root) {
  const raw = String(git(root, ['rev-parse', '--git-path', 'index'])).trim();
  return path.resolve(root, raw);
}

function captureIndexTree(root) {
  const tree = tryGit(root, ['write-tree']);
  return tree == null ? null : String(tree).trim() || null;
}

/**
 * Capture the current visible workspace as a Git tree without touching HEAD,
 * the real index or the worktree. Ignored dependency/build trees stay ignored,
 * while tracked ignored files are preserved by seeding from the real index.
 */
export function captureWorkspaceTree(root) {
  git(root, ['rev-parse', '--git-dir']);
  const sessionId = sessionIdForWorkspace(root);
  // Production executor sees the shared /workspaces volume but not the API
  // container's /tmp. Keep the transient index beside (not inside) session
  // roots so repository filters executed in the executor can use it without
  // accidentally adding the temporary index to the captured worktree.
  const tempBase = sessionId ? WORKSPACES_DIR : os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(tempBase, sessionId ? `.z-agent-turn-index-${sessionId}-` : 'z-agent-turn-index-'));
  fs.chmodSync(tempDir, 0o700);
  const tempIndex = path.join(tempDir, 'index');
  const identity = sessionId ? prepareWorkspaceSandbox(sessionId, root) : null;
  if (identity?.isolated) fs.chownSync(tempDir, identity.uid, identity.gid);
  try {
    const index = currentIndexPath(root);
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, tempIndex);
      if (identity?.isolated) fs.chownSync(tempIndex, identity.uid, identity.gid);
    }
    else {
      const head = tryGit(root, ['rev-parse', '--verify', 'HEAD']);
      const env = { GIT_INDEX_FILE: tempIndex };
      if (head) git(root, ['read-tree', String(head).trim()], { env });
      else git(root, ['read-tree', '--empty'], { env });
    }
    const env = { GIT_INDEX_FILE: tempIndex };
    git(root, [
      'add', '-A', '--', '.',
      ':(exclude).agent-home',
      ':(exclude).agent-home/**',
    ], { env, timeoutMs: 60_000 });
    return String(git(root, ['write-tree'], { env })).trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function persistTreeRef(root, turnId, phase, tree) {
  git(root, ['update-ref', refName(turnId, phase), tree]);
}

function parseNameStatusZ(raw) {
  const tokens = String(raw || '').split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i];
    const filePath = tokens[i + 1];
    const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    out.push({ path: filePath, status, code });
  }
  return out;
}

export function diffWorkspaceTrees(root, beforeTree, afterTree) {
  if (!beforeTree || !afterTree) return [];
  const raw = git(root, ['diff', '--no-ext-diff', '--name-status', '-z', '--no-renames', beforeTree, afterTree, '--']);
  const changes = parseNameStatusZ(raw);
  if (changes.length > MAX_RESULT_CHANGES) throw Object.assign(new Error(`Слишком много изменений в одном ходе: ${changes.length}`), { statusCode: 413 });
  return changes;
}

function clipDiff(text) {
  const value = String(text || '');
  if (value.length <= MAX_DIFF_CHARS) return { patch: value, truncated: false };
  const marker = `\n[diff truncated: ${value.length - MAX_DIFF_CHARS} chars omitted]\n`;
  const budget = Math.max(0, MAX_DIFF_CHARS - marker.length);
  let cut = value.lastIndexOf('\n', budget);
  if (cut < 0) cut = budget;
  return { patch: `${value.slice(0, cut)}${marker}`.slice(0, MAX_DIFF_CHARS), truncated: true };
}

function patchStats(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

export function diffWorkspaceTreePath(root, beforeTree, afterTree, relativePath) {
  const requested = String(relativePath || '').replace(/\\/g, '/');
  safeWorkspacePath(root, requested, { allowMissing: true });
  const change = diffWorkspaceTrees(root, beforeTree, afterTree).find((row) => row.path === requested);
  if (!change) throw Object.assign(new Error('Файл не относится к изменениям этого хода'), { statusCode: 404 });
  const raw = String(git(root, ['diff', '--no-ext-diff', '--no-color', '--no-renames', beforeTree, afterTree, '--', requested]));
  const clipped = clipDiff(raw);
  const binary = /Binary files .* differ|GIT binary patch/i.test(raw);
  return { ...change, ...clipped, binary, ...patchStats(clipped.patch) };
}

function treeEntry(root, tree, relativePath) {
  if (!tree) return null;
  const raw = String(git(root, ['ls-tree', '-z', tree, '--', relativePath]));
  if (!raw) return null;
  const record = raw.split('\0')[0] || '';
  const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t([\s\S]+)$/.exec(record);
  if (!match) return null;
  return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
}

function sameEntry(a, b) {
  if (!a || !b) return a == null && b == null;
  return a.mode === b.mode && a.type === b.type && a.oid === b.oid;
}

function indexEntry(root, relativePath) {
  const raw = String(git(root, ['ls-files', '-s', '-z', '--', relativePath]));
  const rows = raw.split('\0').filter(Boolean);
  if (!rows.length) return null;
  if (rows.length !== 1) return { conflict: true };
  const match = /^(\d+)\s+([0-9a-f]+)\s+(\d+)\t([\s\S]+)$/.exec(rows[0]);
  if (!match || match[3] !== '0') return { conflict: true };
  return { mode: match[1], type: match[1] === '160000' ? 'commit' : 'blob', oid: match[2], path: match[4] };
}

function restoreIndexEntry(root, relativePath, before) {
  if (!before) {
    git(root, ['update-index', '--force-remove', '--', relativePath]);
    return;
  }
  git(root, ['update-index', '--add', '--cacheinfo', before.mode, before.oid, relativePath]);
}

function blobBytes(root, oid) {
  const size = Number(String(git(root, ['cat-file', '-s', oid])).trim()) || 0;
  if (size > MAX_RESTORE_BLOB_BYTES) throw Object.assign(new Error(`Файл слишком большой для безопасного отката (${size} байт)`), { statusCode: 413 });
  return git(root, ['cat-file', 'blob', oid], { encoding: 'buffer', maxBuffer: Math.max(8 * 1024 * 1024, size + 1024) });
}

function restoreWorktreeEntry(root, relativePath, before) {
  const full = safeWorkspacePath(root, relativePath, { allowMissing: true });
  if (!before) {
    fs.rmSync(full, { recursive: true, force: true });
    return;
  }
  if (before.type !== 'blob' || before.mode === '160000') throw Object.assign(new Error(`Откат этого типа Git-объекта пока не поддерживается: ${relativePath}`), { statusCode: 409 });
  fs.rmSync(full, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const data = blobBytes(root, before.oid);
  if (before.mode === '120000') {
    fs.symlinkSync(data.toString('utf8'), full);
    return;
  }
  fs.writeFileSync(full, data);
  fs.chmodSync(full, before.mode === '100755' ? 0o755 : 0o644);
}

/**
 * Reverse exactly one turn. Later edits on the same paths are detected before
 * any write, so rollback is all-or-nothing and never silently clobbers them.
 */
export function rollbackWorkspaceTrees(root, beforeTree, afterTree, beforeIndexTree = null, afterIndexTree = null) {
  const changes = diffWorkspaceTrees(root, beforeTree, afterTree);
  const currentTree = captureWorkspaceTree(root);
  const conflicts = [];
  const work = [];

  for (const change of changes) {
    const before = treeEntry(root, beforeTree, change.path);
    const after = treeEntry(root, afterTree, change.path);
    const current = treeEntry(root, currentTree, change.path);
    if (!sameEntry(current, after) && !sameEntry(current, before)) {
      conflicts.push(change.path);
      continue;
    }
    work.push({ change, before, after, current });
  }

  if (beforeIndexTree && afterIndexTree) {
    for (const item of work) {
      const beforeIndex = treeEntry(root, beforeIndexTree, item.change.path);
      const afterIndex = treeEntry(root, afterIndexTree, item.change.path);
      if (sameEntry(beforeIndex, afterIndex)) continue;
      const currentIndex = indexEntry(root, item.change.path);
      if (currentIndex?.conflict || (!sameEntry(currentIndex, afterIndex) && !sameEntry(currentIndex, beforeIndex))) {
        conflicts.push(item.change.path);
      }
      item.beforeIndex = beforeIndex;
      item.afterIndex = afterIndex;
      item.currentIndex = currentIndex?.conflict ? null : currentIndex;
    }
  }

  if (conflicts.length) {
    const unique = [...new Set(conflicts)];
    throw Object.assign(new Error(`Откат остановлен: более поздняя работа изменила ${unique.join(', ')}`), { statusCode: 409, conflicts: unique });
  }

  const restored = [];
  for (const item of work) {
    if (!sameEntry(item.current, item.before)) restoreWorktreeEntry(root, item.change.path, item.before);
    if (Object.prototype.hasOwnProperty.call(item, 'beforeIndex') && !sameEntry(item.currentIndex, item.beforeIndex)) {
      restoreIndexEntry(root, item.change.path, item.beforeIndex);
    }
    restored.push(item.change.path);
  }
  return { ok: true, restored };
}

function descriptorFromDisk(sessionId) {
  return readJson(activePath(sessionId));
}

function saveActive(sessionId, descriptor) {
  active.set(sessionId, descriptor);
  writeJsonAtomic(activePath(sessionId), descriptor);
}

function clearActive(sessionId) {
  active.delete(sessionId);
  try { fs.rmSync(activePath(sessionId), { force: true }); } catch { /* best effort */ }
}

function latestAssistant(sessionId) {
  const rows = listMessages(sessionId).filter((message) => message?.role === 'assistant');
  rows.sort((a, b) => Number(a?.time?.created || 0) - Number(b?.time?.created || 0));
  return rows.at(-1) || null;
}

function beginTurnResult(sessionId) {
  if (active.has(sessionId) || descriptorFromDisk(sessionId)) return;
  const turn = getTurn(sessionId);
  if (!turn?.turnId) return;
  const root = workspaceFor(sessionId);
  try {
    const beforeTree = captureWorkspaceTree(root);
    const beforeIndexTree = captureIndexTree(root);
    persistTreeRef(root, turn.turnId, 'before', beforeTree);
    saveActive(sessionId, {
      sessionId,
      turnId: turn.turnId,
      beforeTree,
      beforeIndexTree,
      startedAt: Date.now(),
    });
  } catch {
    // Result snapshots are a safety feature, never a reason to prevent a turn.
  }
}

function completeTurnResult(sessionId, reason = 'completed') {
  const descriptor = active.get(sessionId) || descriptorFromDisk(sessionId);
  if (!descriptor?.turnId || !descriptor?.beforeTree) return null;
  const root = workspaceFor(sessionId);
  try {
    const assistant = latestAssistant(sessionId);
    if (!assistant?.id) return null;
    const afterTree = captureWorkspaceTree(root);
    const afterIndexTree = captureIndexTree(root);
    persistTreeRef(root, descriptor.turnId, 'after', afterTree);
    const changes = diffWorkspaceTrees(root, descriptor.beforeTree, afterTree);
    const manifest = {
      version: 1,
      sessionId,
      messageId: assistant.id,
      turnId: descriptor.turnId,
      beforeTree: descriptor.beforeTree,
      afterTree,
      beforeIndexTree: descriptor.beforeIndexTree || null,
      afterIndexTree: afterIndexTree || null,
      startedAt: descriptor.startedAt || Number(assistant?.time?.created) || Date.now(),
      completedAt: Date.now(),
      reason,
      changeCount: changes.length,
      rolledBackAt: null,
    };
    writeJsonAtomic(manifestPath(sessionId, assistant.id), manifest);
    clearActive(sessionId);
    return manifest;
  } catch {
    return null;
  }
}

export function observeTurnResultEvent(sessionId, type, properties = {}) {
  if (type === 'session.status') {
    const status = String(properties?.status || '');
    if (status === 'busy') beginTurnResult(sessionId);
    else if (status === 'idle' || status === 'error') completeTurnResult(sessionId, status);
    return;
  }
  if (type === 'session.idle') completeTurnResult(sessionId, 'idle');
}

export function getTurnResult(sessionId, messageId) {
  safeId(sessionId, 'ses');
  safeId(messageId, 'msg');
  const message = listMessages(sessionId).find((row) => row?.id === messageId && row?.role === 'assistant');
  if (!message) throw Object.assign(new Error('Ответ не найден'), { statusCode: 404 });
  const manifest = readJson(manifestPath(sessionId, messageId));
  if (!manifest?.beforeTree || !manifest?.afterTree) throw Object.assign(new Error('Для этого ответа нет сохранённого результата workspace'), { statusCode: 404 });
  const root = workspaceFor(sessionId);
  const changes = diffWorkspaceTrees(root, manifest.beforeTree, manifest.afterTree);
  return { ...manifest, changes };
}

export function getTurnResultDiff(sessionId, messageId, relativePath) {
  const result = getTurnResult(sessionId, messageId);
  return diffWorkspaceTreePath(workspaceFor(sessionId), result.beforeTree, result.afterTree, relativePath);
}

export function rollbackTurnResult(sessionId, messageId) {
  const result = getTurnResult(sessionId, messageId);
  if (result.rolledBackAt) return { ok: true, restored: [], alreadyRolledBack: true, rolledBackAt: result.rolledBackAt };
  const root = workspaceFor(sessionId);
  const rollback = rollbackWorkspaceTrees(root, result.beforeTree, result.afterTree, result.beforeIndexTree, result.afterIndexTree);
  syncSandboxOwnership(sessionId, root, root);
  const updated = { ...result, changes: undefined, rolledBackAt: Date.now() };
  writeJsonAtomic(manifestPath(sessionId, messageId), updated);
  return { ...rollback, rolledBackAt: updated.rolledBackAt };
}

export function clearTurnResults(sessionId) {
  active.delete(sessionId);
  try { fs.rmSync(resultDir(sessionId), { recursive: true, force: true }); } catch { /* best effort */ }
}

export function recoverDanglingTurnResults() {
  if (!fs.existsSync(RESULT_DIR)) return;
  for (const entry of fs.readdirSync(RESULT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^ses_[A-Za-z0-9]+$/.test(entry.name)) continue;
    if (!fs.existsSync(activePath(entry.name))) continue;
    const turn = getTurn(entry.name);
    if (turn && ['running', 'waiting_permission', 'waiting_user_input'].includes(String(turn.lifecycle || ''))) continue;
    completeTurnResult(entry.name, 'runtime_restart');
  }
}

try { recoverDanglingTurnResults(); } catch { /* startup recovery is best effort */ }
