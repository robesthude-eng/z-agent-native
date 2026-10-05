import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeEditFile, executeReadFile, executeWriteFile } from '../server/native/tools/filesystem.mjs';
import { contentVersion, openWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from '../server/native/workspace-fs.mjs';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-wsfs-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_MARKER\n');
  return { root, outside };
}

// lstat-based path checks pass, then the attacker swaps the path: emulate the
// window by hiding symlinks from lstat while the descriptor chain opens.
function hideSymlinksFromLstat(t) {
  const original = fs.lstatSync;
  fs.lstatSync = (target, ...rest) => {
    const stat = original(target, ...rest);
    if (!stat?.isSymbolicLink?.()) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isSymbolicLink: () => false });
  };
  t.after(() => { fs.lstatSync = original; });
}

test('read does not follow a file swapped for a symlink after validation', async (t) => {
  const { root, outside } = sandbox(t);
  const target = path.join(root, 'normal.txt');
  fs.writeFileSync(target, 'normal\n');
  const pending = executeReadFile(root, { path: 'normal.txt' });
  fs.rmSync(target);
  fs.symlinkSync(path.join(outside, 'secret.txt'), target);
  const result = await pending;
  assert.doesNotMatch(result.output, /OUTSIDE_MARKER/);
  assert.match(result.output, /normal/);
});

test('a symlinked directory that slips past the path check is not followed', (t) => {
  const { root, outside } = sandbox(t);
  fs.symlinkSync(outside, path.join(root, 'sub'));
  hideSymlinksFromLstat(t);
  assert.throws(() => readWorkspaceFile(root, 'sub/secret.txt'));
  assert.throws(() => writeWorkspaceFile(root, 'sub/secret.txt', 'pwned'));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE_MARKER\n');
});

test('a symlinked final component is refused for read, write and edit', async (t) => {
  const { root, outside } = sandbox(t);
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  hideSymlinksFromLstat(t);
  assert.throws(() => openWorkspaceFile(root, 'link.txt'), /Symlink/);
  await assert.rejects(() => executeReadFile(root, { path: 'link.txt' }), /Symlink/);
  assert.throws(() => executeWriteFile(root, { path: 'link.txt', content: 'pwned' }), /Symlink/);
  assert.throws(() => executeEditFile(root, { path: 'link.txt', oldText: 'OUTSIDE', newText: 'pwned' }), /Symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE_MARKER\n');
});

test('workspace writes create parents and keep reporting overwrite details', (t) => {
  const { root } = sandbox(t);
  const created = executeWriteFile(root, { path: 'a/b/c.txt', content: 'one\ntwo\n' });
  assert.match(created.output, /^Created a\/b\/c\.txt: 2 lines/);
  const overwritten = executeWriteFile(root, { path: 'a/b/c.txt', content: 'x\n' });
  assert.match(overwritten.output, /was 2 lines/);
  const edited = executeEditFile(root, { path: 'a/b/c.txt', oldText: 'x', newText: 'y' });
  assert.match(edited.output, /^Edited a\/b\/c\.txt/);
  assert.equal(fs.readFileSync(path.join(root, 'a/b/c.txt'), 'utf8'), 'y\n');
});

test('a write guard runs before the file is created or truncated', (t) => {
  const { root } = sandbox(t);
  const conflict = () => { throw Object.assign(new Error('conflict'), { code: 'WORKSPACE_FILE_CONFLICT' }); };
  assert.throws(() => writeWorkspaceFile(root, 'new.txt', 'draft', { guard: conflict }), /conflict/);
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);

  fs.writeFileSync(path.join(root, 'kept.txt'), 'fresh work');
  const stale = contentVersion('older text');
  const guard = (previous) => { if (contentVersion(previous) !== stale) conflict(); };
  assert.throws(() => writeWorkspaceFile(root, 'kept.txt', 'stale draft', { guard }), /conflict/);
  assert.equal(fs.readFileSync(path.join(root, 'kept.txt'), 'utf8'), 'fresh work');
});
