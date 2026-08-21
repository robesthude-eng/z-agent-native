import fs from 'node:fs';
import path from 'node:path';

const HTML_NAME = /^[A-Za-z0-9._-]{1,80}\.html?$/i;

function isHtmlFile(dir, name) {
  if (!HTML_NAME.test(name)) return false;
  try {
    const st = fs.statSync(path.join(dir, name));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Which workspace-root HTML the in-product Preview panel should open.
 *
 * index.html always wins. If the agent named the page checkers.html (or
 * similar) and there is no index.html, Preview still has something to show:
 * a single root HTML file, otherwise the newest one.
 */
export function previewDocument(workspace) {
  const root = String(workspace || '');
  if (!root) return null;
  try {
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  if (isHtmlFile(root, 'index.html')) return 'index.html';
  if (isHtmlFile(root, 'index.htm')) return 'index.htm';
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const files = [];
  for (const name of names) {
    if (!isHtmlFile(root, name)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(root, name)).mtimeMs; } catch { continue; }
    files.push({ name, mtime });
  }
  if (!files.length) return null;
  if (files.length === 1) return files[0].name;
  files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return files[0].name;
}

export function previewIsReady(workspace) {
  return Boolean(previewDocument(workspace));
}
