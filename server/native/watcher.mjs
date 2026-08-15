import fs from 'node:fs';
import path from 'node:path';
import { emit } from './events.mjs';

const watchers = new Map();

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
  const paths = new Set();
  const flush = () => {
    timer = null;
    const changed = [...paths];
    paths.clear();
    if (!changed.length) return;
    emit(sessionId, 'file.watcher.updated', { paths: changed, path: changed[0] || '.' });
  };
  const observe = (filename) => {
    const eventPath = safeEventPath(filename);
    if (shouldIgnoreEvent(eventPath)) return;
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
  watcher.on('error', () => closeWorkspaceWatcher(sessionId));
  watcher.unref?.();
  const state = { watcher, root };
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
