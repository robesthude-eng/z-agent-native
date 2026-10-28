// Applies a "*** Begin Patch" patch (see codex-patch.mjs) to a session workspace.
//
// Every file is read and every hunk applied in memory first; nothing is written unless the whole patch works. The
// writes then go through the descriptor-verified helpers of workspace-fs.mjs (no symlink is followed, nothing leaves the
// workspace), and if one of them fails the files already written are put back. No git, no shell and no sandbox
// executor is involved, so this works in every deployment.
//
// Ported from opencode (https://github.com/sst/opencode, packages/opencode/src/tool/apply_patch.ts), MIT License,
// Copyright (c) 2025 opencode: all hunks are verified before the first write. Adapted for z-agent: workspace-fs
// primitives instead of path-based I/O, rollback of partial writes, a changed-on-disk check, Add File never overwrites.

import fs from 'node:fs';
import path from 'node:path';
import { syncSandboxOwnership } from '../sandbox.mjs';
import { safeWorkspacePath } from '../security.mjs';
import { deleteWorkspaceFile, openWorkspaceFile, readFd, readWorkspaceFile, replaceFdContent } from '../workspace-fs.mjs';
import { applyChunks, parseCodexPatch } from './codex-patch.mjs';
import { MAX_READ_BYTES } from './filesystem.mjs';

const MAX_LISTED_LINES = 6;
const NOT_A_DIRECTORY = 'a parent of this path is a file, not a directory';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function lineCount(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function bufferLineCount(buffer) {
  if (!buffer.length) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines += 1;
  return buffer.at(-1) === 0x0a ? lines : lines + 1;
}

/** The workspace-relative form of a path from the patch; absolute paths and ".." are refused like in unified diffs. */
function patchPath(root, raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]+/).includes('..')) {
    throw new Error(`Unsafe patch path: ${value}. Use paths relative to the workspace root.`);
  }
  let full;
  try {
    full = safeWorkspacePath(root, value, { allowMissing: true });
  } catch (err) {
    if (err?.code === 'ENOTDIR') throw new Error(`${value}: ${NOT_A_DIRECTORY}`);
    throw err;
  }
  const rel = path.relative(path.resolve(root), full).split(path.sep).join('/');
  if (!rel) throw new Error(`Patch path must name a file inside the workspace: ${value}`);
  return rel;
}

function decodeText(buffer, rel) {
  if (buffer.includes(0)) throw new Error(`Binary file ${rel}: apply_patch only edits text files; use bash or a specialized tool instead`);
  try {
    return decoder.decode(buffer);
  } catch {
    throw new Error(`${rel} is not valid UTF-8, so editing it as text would corrupt it; use bash for this file`);
  }
}

/** The file as it is on disk right now, or `original: null` when it does not exist. */
function readEntry(root, rel) {
  try {
    const { buffer, stat } = readWorkspaceFile(root, rel, { maxBytes: MAX_READ_BYTES });
    return { rel, original: buffer, current: buffer, mode: stat.mode & 0o7777 };
  } catch (err) {
    if (err?.code === 'ENOENT') return { rel, original: null, current: null, mode: null };
    if (err?.code === 'ENOTDIR') throw new Error(`${rel}: ${NOT_A_DIRECTORY}`);
    if (err?.code === 'FILE_TOO_LARGE') {
      throw new Error(
        `${rel} is too large for apply_patch (${err.size} bytes, limit ${MAX_READ_BYTES}); change it with edit, or use read with offset/limit`,
      );
    }
    throw err;
  }
}

function listLines(changes) {
  const lines = changes.slice(0, MAX_LISTED_LINES).map((change) => change.line);
  return `${lines.join(', ')}${changes.length > MAX_LISTED_LINES ? ', …' : ''}`;
}

/**
 * Turn the hunks into the final content of every file they touch. Reads the workspace, writes nothing.
 * Returns `{ files, report, notes }`; `files` maps a relative path to `{ original, current, mode }` (a Buffer, or null
 * when the file does not exist before / after the patch).
 */
function planPatch(root, hunks) {
  const files = new Map();
  const report = [];
  const notes = [];
  const load = (rel) => {
    let entry = files.get(rel);
    if (!entry) {
      entry = readEntry(root, rel);
      files.set(rel, entry);
    }
    return entry;
  };

  for (const hunk of hunks) {
    const rel = patchPath(root, hunk.path);
    if (hunk.type === 'add') {
      const entry = load(rel);
      if (entry.current !== null) {
        throw new Error(
          `Cannot add ${rel}: the file already exists. Use '*** Update File: ${rel}' to change it, or '*** Delete File: ${rel}' before adding it again.`,
        );
      }
      entry.current = Buffer.from(hunk.content, 'utf8');
      report.push({ kind: 'A', path: rel, added: lineCount(hunk.content), removed: 0 });
    } else if (hunk.type === 'delete') {
      const entry = load(rel);
      if (entry.current === null) throw new Error(`Cannot delete ${rel}: there is no such file.`);
      report.push({ kind: 'D', path: rel, added: 0, removed: bufferLineCount(entry.current) });
      entry.current = null;
    } else {
      const entry = load(rel);
      if (entry.current === null) {
        throw new Error(`Cannot update ${rel}: there is no such file. Use '*** Add File: ${rel}' to create it.`);
      }
      let next = entry.current;
      let applied = { added: 0, removed: 0, changes: [], notes: [] };
      if (hunk.chunks.length) {
        applied = applyChunks(decodeText(entry.current, rel), hunk.chunks, rel);
        next = Buffer.from(applied.text, 'utf8');
      }
      notes.push(...applied.notes);
      const target = hunk.movePath ? patchPath(root, hunk.movePath) : rel;
      if (target === rel) {
        entry.current = next;
        report.push({ kind: 'M', path: rel, ...applied });
      } else {
        const destination = load(target);
        if (destination.current !== null) throw new Error(`Cannot move ${rel} to ${target}: the destination already exists.`);
        destination.current = next;
        destination.mode = entry.mode;
        entry.current = null;
        report.push({ kind: 'R', path: rel, to: target, ...applied });
      }
    }
  }
  return { files, report, notes };
}

function finalKind(entry) {
  if (entry.original === null) return entry.current === null ? 'none' : 'create';
  if (entry.current === null) return 'delete';
  return entry.original.equals(entry.current) ? 'none' : 'update';
}

function missingParents(root, rel) {
  const missing = [];
  let current = path.resolve(root);
  for (const segment of rel.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (missing.length || !fs.existsSync(current)) missing.push(current);
  }
  return missing;
}

function changedOnDisk(rel) {
  return new Error(`${rel} changed while the patch was being applied; nothing was kept. Read it again and resend the patch.`);
}

function createFile(root, entry, undo) {
  const parents = missingParents(root, entry.rel);
  undo.push({
    rel: entry.rel,
    run: () => {
      // Directories created for the file go away with it when nothing else lives in them.
      for (const dir of parents.reverse()) {
        try {
          fs.rmdirSync(dir);
        } catch {
          break;
        }
      }
    },
  });
  let handle;
  try {
    handle = openWorkspaceFile(root, entry.rel, { write: true, create: true, exclusive: true, mkdirs: true });
  } catch (err) {
    throw err?.code === 'EEXIST' ? changedOnDisk(entry.rel) : err;
  }
  undo.push({ rel: entry.rel, run: () => deleteWorkspaceFile(root, entry.rel) });
  try {
    replaceFdContent(handle.fd, entry.current);
    if (entry.mode !== null) fs.fchmodSync(handle.fd, entry.mode);
  } finally {
    fs.closeSync(handle.fd);
  }
}

function updateFile(root, entry, undo) {
  const handle = openWorkspaceFile(root, entry.rel, { write: true });
  try {
    if (handle.stat.size !== entry.original.length || !readFd(handle.fd, handle.stat.size).equals(entry.original))
      throw changedOnDisk(entry.rel);
    undo.push({
      rel: entry.rel,
      run: () => {
        const again = openWorkspaceFile(root, entry.rel, { write: true });
        try {
          replaceFdContent(again.fd, entry.original);
        } finally {
          fs.closeSync(again.fd);
        }
      },
    });
    replaceFdContent(handle.fd, entry.current);
  } finally {
    fs.closeSync(handle.fd);
  }
}

function removeFile(root, entry, undo) {
  let now;
  try {
    now = readWorkspaceFile(root, entry.rel, { maxBytes: MAX_READ_BYTES }).buffer;
  } catch {
    throw changedOnDisk(entry.rel);
  }
  if (!now.equals(entry.original)) throw changedOnDisk(entry.rel);
  deleteWorkspaceFile(root, entry.rel);
  undo.push({
    rel: entry.rel,
    run: () => {
      const handle = openWorkspaceFile(root, entry.rel, { write: true, create: true, exclusive: true, mkdirs: true });
      try {
        replaceFdContent(handle.fd, entry.original);
        if (entry.mode !== null) fs.fchmodSync(handle.fd, entry.mode);
      } finally {
        fs.closeSync(handle.fd);
      }
    },
  });
}

/** Write the planned files; on any failure put everything back and throw. Returns the paths that were written. */
function commitPlan(root, files) {
  const entries = [...files.values()].map((entry) => ({ entry, kind: finalKind(entry) }));
  const undo = [];
  try {
    // Creating and rewriting come first and deleting last: the step that loses data is the one that runs when
    // everything else has already worked.
    for (const { entry, kind } of entries) if (kind === 'create') createFile(root, entry, undo);
    for (const { entry, kind } of entries) if (kind === 'update') updateFile(root, entry, undo);
    for (const { entry, kind } of entries) if (kind === 'delete') removeFile(root, entry, undo);
  } catch (err) {
    const stuck = [];
    for (const step of undo.reverse()) {
      try {
        step.run();
      } catch {
        stuck.push(step.rel);
      }
    }
    const state = stuck.length
      ? `Rolling back failed for ${[...new Set(stuck)].join(', ')}: check these files.`
      : 'The patch was rolled back: no file was changed.';
    throw new Error(`Patch failed: ${err?.message || err}. ${state}`);
  }
  // Deleted files go last: the syntax check that follows looks only at the first few paths.
  const changed = entries.filter(({ kind }) => kind !== 'none').map(({ entry, kind }) => ({ rel: entry.rel, kind }));
  return [...changed.filter(({ kind }) => kind !== 'delete'), ...changed.filter(({ kind }) => kind === 'delete')];
}

function describe(item) {
  const stats = `+${item.added} -${item.removed}`;
  const where = item.changes?.length ? `, ${item.changes.length === 1 ? 'line' : 'lines'} ${listLines(item.changes)}` : '';
  if (item.kind === 'A') return `A ${item.path} (+${item.added})`;
  if (item.kind === 'D') return `D ${item.path} (-${item.removed})`;
  if (item.kind === 'R') return `R ${item.path} -> ${item.to} (${item.changes?.length ? `${stats}${where}` : 'renamed'})`;
  return `M ${item.path} (${item.changes?.length ? `${stats}${where}` : 'no changes'})`;
}

/** Parse the patch and work out the new content of every file it touches, without writing anything. */
export function planCodexPatch(root, patchText) {
  return planPatch(root, parseCodexPatch(patchText));
}

/** Write a plan made by planCodexPatch (all of it, or none of it) and describe the result for the model. */
export function commitCodexPlan(root, plan, sessionId = null) {
  const { files, report, notes } = plan;
  const written = commitPlan(root, files);
  if (sessionId) {
    for (const { rel, kind } of written) if (kind !== 'delete') syncSandboxOwnership(sessionId, root, path.join(root, rel));
  }
  const added = report.reduce((sum, item) => sum + item.added, 0);
  const removed = report.reduce((sum, item) => sum + item.removed, 0);
  const untouched = report.filter((item) => item.kind === 'M' && !item.changes?.length).map((item) => item.path);
  const paths = written.map(({ rel }) => rel);
  const fileCount = new Set(report.map((item) => item.to ?? item.path)).size;
  const output = [
    `Patch applied: ${fileCount} file${fileCount === 1 ? '' : 's'} (+${added} -${removed}).`,
    ...report.map(describe),
    ...notes.map((note) => `Note: ${note}`),
    ...(untouched.length ? [`Note: the hunks for ${untouched.join(', ')} left the file as it was.`] : []),
  ].join('\n');
  return {
    output,
    title: fileCount === 1 ? (report[0].to ?? report[0].path) : `${fileCount} files`,
    metadata: {
      patchFormat: 'codex',
      files: report.map((item) => ({
        kind: item.kind,
        path: item.path,
        ...(item.to ? { to: item.to } : {}),
        added: item.added,
        removed: item.removed,
      })),
    },
    mutatedPaths: paths,
  };
}

export function executeCodexPatch(root, patchText, sessionId = null) {
  return commitCodexPlan(root, planCodexPatch(root, patchText), sessionId);
}
