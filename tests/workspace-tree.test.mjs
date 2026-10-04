import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectWorkspaceTree } from '../server/native/workspace-tree.mjs';

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-listing-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('complete tree includes root binaries regardless of their size', () => fixture(root => {
  fs.mkdirSync(path.join(root, 'work'));
  const file = path.join(root, 'vk-noads-8.193-arm64.xapk');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 239141525); fs.closeSync(fd);
  const nodes = collectWorkspaceTree(root);
  assert.equal(nodes.find(n => n.path === path.basename(file))?.size, 239141525);
}));

test('large nested folder never produces a falsely complete tree without root files', () => fixture(root => {
  fs.mkdirSync(path.join(root, '.venv'));
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, '.venv', `file-${i}`), '');
  fs.writeFileSync(path.join(root, 'result.xapk'), 'artifact');
  assert.throws(() => collectWorkspaceTree(root, { maxEntries: 32 }), { statusCode: 409, code: 'WORKSPACE_TREE_LIMIT' });
  assert.ok(fs.readdirSync(root).includes('result.xapk'), 'fallback root listing retains the artifact');
}));

test('exact budget is complete, exceeding it is explicit', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b');
  assert.equal(collectWorkspaceTree(root, { maxEntries: 2 }).length, 2);
  fs.writeFileSync(path.join(root, 'c.txt'), 'c');
  assert.throws(() => collectWorkspaceTree(root, { maxEntries: 2 }), { code: 'WORKSPACE_TREE_LIMIT' });
}));

test('managed home is hidden and symlinks are not followed', () => fixture(root => {
  fs.mkdirSync(path.join(root, '.agent-home'));
  fs.writeFileSync(path.join(root, '.agent-home', 'private'), 'hidden');
  fs.symlinkSync('/etc', path.join(root, 'external'));
  const nodes = collectWorkspaceTree(root);
  assert.deepEqual(nodes.map(n => n.path), ['external']);
  assert.equal(nodes[0].isDirectory, false);
}));
