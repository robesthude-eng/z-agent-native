import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Evidence for completion bookkeeping, not a security boundary. A shell's
// spelling cannot prove that it edited a file (e.g. java -version or free -m).
// Bound traversal and fall back conservatively when either snapshot is partial.
const IGNORED_ROOTS = new Set(['.agent-home', '.agent-skills', '.git']);
// Зависимости, кэши и артефакты сборки на любой глубине. В Node-проекте один
// node_modules — десятки тысяч файлов: без исключения скан упирался в лимит,
// считался неполным, и любая неизвестная команда (java -version) снова
// засчитывалась как правка. Изменения здесь — не правки исходников.
const IGNORED_DIRS = new Set([
  'node_modules',
  '.pnpm-store',
  '.npm',
  '.yarn',
  '.turbo',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  '.cache',
  'dist',
  'build',
  'target',
  'coverage',
  '.dart_tool',
  'Pods',
  '.screenshots',
]);

export async function snapshotWorkspace(root, { maxEntries = 20_000, maxMs = 250 } = {}) {
  const entries = new Map();
  const pending = [''];
  const started = performance.now();
  let visited = 0;
  let complete = true;
  while (pending.length) {
    if (visited >= maxEntries || performance.now() - started > maxMs) {
      complete = false;
      break;
    }
    const relative = pending.pop();
    try {
      const full = path.join(root, relative);
      const stat = await fs.lstat(full);
      visited += 1;
      if (stat.isDirectory()) {
        if (relative) entries.set(relative, `dir:${stat.mode}`);
        for (const name of await fs.readdir(full)) {
          if (name === '.git' || IGNORED_DIRS.has(name) || (!relative && IGNORED_ROOTS.has(name))) continue;
          pending.push(relative ? `${relative}/${name}` : name);
          if (pending.length + visited > maxEntries) {
            complete = false;
            break;
          }
        }
      } else {
        // lstat never follows a symlink. Include ctime so an overwritten file
        // with a restored mtime is still a change.
        entries.set(relative, `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`);
      }
    } catch {
      complete = false;
    }
  }
  return { entries, complete };
}

export function compareWorkspaceSnapshots(before, after) {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  const changed = [...paths].filter((name) => {
    // Missing from a partial scan does not prove deletion or creation.
    if (!before.entries.has(name)) return before.complete;
    if (!after.entries.has(name)) return after.complete;
    return before.entries.get(name) !== after.entries.get(name);
  });
  return { complete: before.complete && after.complete, paths: changed.slice(0, 50), truncated: changed.length > 50 };
}
