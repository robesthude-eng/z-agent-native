import fs from 'node:fs';
import path from 'node:path';
import { emit } from './events.mjs';

const watchers = new Map();
// A bulk operation (npm install, git checkout, build output) can emit tens of
// thousands of events between two flushes.
const MAX_PENDING_WATCH_PATHS = 500;
const WATCH_RETRY_LIMIT = 5;

function safeEventPath(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '.');
  const normalized = text.split(path.sep).join('/').replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) return '.';
  return normalized;
}

function shouldIgnoreEvent(eventPath) {
  return eventPath === '.agent-home' || eventPath.startsWith('.agent-home/');
}

export function ensureWorkspaceWatcher(sessionId, root) {
  if (watchers.has(sessionId)) return watchers.get(sessionId);
  let timer = null;
  let truncated = false;
  const paths = new Set();
  const flush = () => {
    timer = null;
    const changed = [...paths];
    const overflowed = truncated;
    paths.clear();
    truncated = false;
    if (!changed.length) return;
    // `truncated` tells the client the list is partial and it should refresh the
    // tree instead of trusting these paths as the complete change set.
    emit(sessionId, 'file.watcher.updated', { paths: changed, path: changed[0] || '.', truncated: overflowed });
  };
  const observe = (filename) => {
    const eventPath = safeEventPath(filename);
    if (shouldIgnoreEvent(eventPath)) return;
    if (paths.size >= MAX_PENDING_WATCH_PATHS) { truncated = true; return; }
    paths.add(eventPath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 120);
    timer.unref?.();
  };
  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => observe(filename));
  } catch {
    // Some filesystems do not support recursive watch. Root-level events plus
    // UI polling still provide a safe fallback; tool operations emit directly.
    try {
      watcher = fs.watch(root, (_event, filename) => observe(filename));
    } catch {
      return null;
    }
  }
  watcher.on('error', () => {
    // Closing without recreating silently disabled file events for the rest of
    // the session. Retry with exponential backoff instead.
    const attempt = (watchers.get(sessionId)?.attempt || 0) + 1;
    closeWorkspaceWatcher(sessionId);
    if (attempt > WATCH_RETRY_LIMIT) return;
    const retry = setTimeout(() => {
      const next = ensureWorkspaceWatcher(sessionId, root);
      if (next) next.attempt = attempt;
    }, Math.min(30_000, 500 * 2 ** (attempt - 1)));
    retry.unref?.();
  });
  watcher.unref?.();
  const state = { watcher, root, attempt: 0 };
  watchers.set(sessionId, state);
  return state;
}

export function closeWorkspaceWatcher(sessionId) {
  const state = watchers.get(sessionId);
  if (!state) return;
  watchers.delete(sessionId);
  try { state.watcher.close(); } catch {}
}

export function closeAllWorkspaceWatchers() {
  for (const sessionId of [...watchers.keys()]) closeWorkspaceWatcher(sessionId);
}
