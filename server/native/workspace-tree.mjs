import fs from 'node:fs';
import path from 'node:path';

export const MAX_TREE_ENTRIES = 10_000;

// A partial recursive listing must never look like a complete workspace. The
// UI falls back to listing the root and lazily loading expanded directories.
export function collectWorkspaceTree(root, { maxEntries = MAX_TREE_ENTRIES } = {}) {
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.agent-home') continue;
      if (out.length >= maxEntries) {
        throw Object.assign(new Error('Workspace is too large for a complete recursive listing; use directory listing.'), {
          statusCode: 409,
          code: 'WORKSPACE_TREE_LIMIT',
        });
      }
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch (error) {
        // A concurrent deletion is harmless; other read failures must not be
        // disguised as an empty directory.
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      out.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        name: entry.name,
        type: stat.isDirectory() ? 'directory' : 'file',
        isDirectory: stat.isDirectory(),
        size: stat.isFile() ? stat.size : undefined,
      });
      // Never follow symlinks outside the session's workspace.
      if (entry.isDirectory() && !stat.isSymbolicLink()) walk(full);
    }
  };
  walk(root);
  return out;
}
