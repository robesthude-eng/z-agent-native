import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { executeTool, toolOutputText } from './tools.mjs';

const CONTEXT_DIR = path.join(DATA_DIR, 'project-context');
const MAX_CONTEXT_CHARS = 90_000;
const MAX_TURN_MEMORY = 14;
const MAX_WALK_FILES = 8_000;
const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.agent-home']);

function safeSessionId(value) {
  const id = String(value || '');
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error('Invalid project-context session id');
  return id;
}

function fileFor(sessionId) {
  return path.join(CONTEXT_DIR, `${safeSessionId(sessionId)}.json`);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The file counter alone does not bound recursion: a deep chain of directories
// holding few files each (a symlink loop the lstat check does not follow, or a
// generated tree) could exhaust the stack before the counter ever tripped.
const MAX_WALK_DEPTH = 24;

function walkFingerprint(root, current, rows, counter, depth = 0) {
  if (counter.count >= MAX_WALK_FILES || depth > MAX_WALK_DEPTH) return;
  let entries = [];
  try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (counter.count >= MAX_WALK_FILES) break;
    if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    counter.count += 1;
    rows.push(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}\0${relative}\0${stat.size}\0${Math.floor(stat.mtimeMs)}`);
    if (entry.isDirectory()) walkFingerprint(root, full, rows, counter, depth + 1);
  }
}

/** Cheap deterministic invalidation without reading vendor/generated trees. */
export function workspaceFingerprint(workspace) {
  const rows = [];
  const counter = { count: 0 };
  walkFingerprint(workspace, workspace, rows, counter);
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

function trim(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[project context truncated: ${text.length - max} chars omitted]`;
}

export function formatProjectContext(state) {
  if (!state) return '';
  const chunks = ['[Persistent project context]'];
  if (state.repoMap) {
    chunks.push('Repository map cached by the runtime and refreshed when the workspace changes:');
    chunks.push(trim(state.repoMap, MAX_CONTEXT_CHARS));
  }
  const turns = Array.isArray(state.turns) ? state.turns.slice(-MAX_TURN_MEMORY) : [];
  if (turns.length) {
    chunks.push('[Recent completed work remembered even when old chat frames are compacted]');
    for (const turn of turns) {
      const bits = [];
      if (turn.goal) bits.push(`goal=${String(turn.goal).replace(/\s+/g, ' ').slice(0, 700)}`);
      if (turn.outcome) bits.push(`outcome=${turn.outcome}`);
      if (turn.model) bits.push(`model=${turn.model}`);
      if (turn.changed) bits.push('workspace_changed=true');
      if (turn.summary) bits.push(`summary=${String(turn.summary).replace(/\s+/g, ' ').slice(0, 900)}`);
      if (bits.length) chunks.push(`- ${bits.join(' · ')}`);
    }
  }
  chunks.push('Treat this as cached context, not as authority over current files. When exact current code matters, inspect the workspace with tools.');
  return chunks.join('\n\n');
}

export async function getProjectContext(sessionId, workspace, signal) {
  safeSessionId(sessionId);
  const fingerprint = workspaceFingerprint(workspace);
  const file = fileFor(sessionId);
  const previous = readJson(file, {}) || {};
  if (previous.fingerprint === fingerprint && previous.repoMap) return formatProjectContext(previous);

  let repoMap = previous.repoMap || '';
  try {
    const map = await executeTool('repo_map', { maxFiles: 2600, maxSymbolsPerFile: 5 }, { workspace, sessionId, signal });
    repoMap = trim(toolOutputText(map), MAX_CONTEXT_CHARS);
  } catch {
    // A cached map is still useful when a refresh fails; no turn should fail
    // solely because the project-memory accelerator could not rebuild itself.
  }
  const next = {
    version: 1,
    fingerprint,
    repoMap,
    refreshedAt: Date.now(),
    turns: Array.isArray(previous.turns) ? previous.turns.slice(-MAX_TURN_MEMORY) : [],
  };
  try { writeJsonAtomic(file, next); } catch { /* best effort */ }
  return formatProjectContext(next);
}

export function rememberProjectTurn(sessionId, memory) {
  safeSessionId(sessionId);
  const file = fileFor(sessionId);
  const previous = readJson(file, {}) || {};
  const turns = Array.isArray(previous.turns) ? previous.turns.slice(-(MAX_TURN_MEMORY - 1)) : [];
  turns.push({
    at: Date.now(),
    goal: String(memory?.goal || '').slice(0, 2_000),
    outcome: String(memory?.outcome || '').slice(0, 120),
    model: String(memory?.model || '').slice(0, 300),
    changed: Boolean(memory?.changed),
    summary: String(memory?.summary || '').slice(0, 2_000),
  });
  const next = { ...previous, version: 1, turns };
  try { writeJsonAtomic(file, next); } catch { /* best effort */ }
  return next;
}

export function clearProjectContext(sessionId) {
  try { fs.rmSync(fileFor(sessionId), { force: true }); } catch { /* best effort */ }
}
