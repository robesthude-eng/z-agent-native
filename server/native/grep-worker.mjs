import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { readWorkspaceFile } from './workspace-fs.mjs';

// Model/user supplied regular expressions run here, never on the main thread:
// a catastrophically backtracking pattern can only stall this worker, which the
// parent terminates on timeout.
const {
  files = [], pattern = '', max = 100, regex = false, root = null,
  maxBytes = 512 * 1024, maxLine = 2000,
} = workerData || {};

// With a workspace root every file is opened through the descriptor chain, so
// a path swapped for a symlink after the parent's checks cannot leak content
// from outside the workspace into search results.
function readCandidate(item) {
  if (root) {
    try { return readWorkspaceFile(root, item.path, { maxBytes }).buffer; }
    catch (err) { if (err?.code === 'FILE_TOO_LARGE') return null; throw err; }
  }
  return fs.readFileSync(item.full);
}

let matcher = null;
const needle = String(pattern).toLowerCase();
if (regex) {
  try {
    matcher = new RegExp(pattern, 'i');
  } catch (err) {
    parentPort?.postMessage({ error: `invalid regular expression: ${err?.message || err}` });
    process.exit(0);
  }
}

const hits = [];
for (const item of files) {
  if (hits.length >= max) break;
  try {
    const buf = readCandidate(item);
    if (!buf || buf.length > maxBytes || buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      const matches = matcher
        ? matcher.test(lines[i])
        : lines[i].toLowerCase().includes(needle);
      if (matches) hits.push(`${item.path}:${i + 1}: ${lines[i].slice(0, maxLine)}`);
    }
  } catch { /* unreadable file */ }
}
parentPort?.postMessage({ hits });
