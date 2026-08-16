import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureWorkspaceTree,
  diffWorkspaceTreePath,
  diffWorkspaceTrees,
  rollbackWorkspaceTrees,
} from '../server/native/turn-results.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-turn-result-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'tests@example.com']);
  git(root, ['config', 'user.name', 'Z Agent Tests']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.agent-home/\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'baseline\n');
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

function indexTree(root) {
  return git(root, ['write-tree']).trim();
}

test('turn trees describe only the exact before/after workspace transition', () => {
  const root = repo();
  // User already had a dirty change before the agent turn; it belongs to the
  // baseline and must not be reported as work performed by the turn.
  fs.writeFileSync(path.join(root, 'keep.txt'), 'user change before turn\n');
  const before = captureWorkspaceTree(root);

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'agent change\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new from agent\n');
  const after = captureWorkspaceTree(root);

  const changes = diffWorkspaceTrees(root, before, after);
  assert.deepEqual(changes.map((row) => [row.status, row.path]), [
    ['added', 'new.txt'],
    ['modified', 'tracked.txt'],
  ]);
  const diff = diffWorkspaceTreePath(root, before, after, 'tracked.txt');
  assert.match(diff.patch, /-baseline/);
  assert.match(diff.patch, /\+agent change/);
});

test('rollback restores worktree and index to the exact pre-turn state', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'keep.txt'), 'dirty before turn\n');
  const beforeTree = captureWorkspaceTree(root);
  const beforeIndex = indexTree(root);

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'agent staged change\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'agent new file\n');
  git(root, ['add', 'tracked.txt', 'new.txt']);
  const afterTree = captureWorkspaceTree(root);
  const afterIndex = indexTree(root);

  const result = rollbackWorkspaceTrees(root, beforeTree, afterTree, beforeIndex, afterIndex);
  assert.deepEqual(new Set(result.restored), new Set(['new.txt', 'tracked.txt']));
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'baseline\n');
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'dirty before turn\n');
  assert.equal(git(root, ['diff', '--cached', '--name-only']).trim(), '');
  assert.equal(git(root, ['diff', '--name-only']).trim(), 'keep.txt');
});

test('rollback preserves unrelated later work', () => {
  const root = repo();
  const before = captureWorkspaceTree(root);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'agent change\n');
  const after = captureWorkspaceTree(root);

  fs.writeFileSync(path.join(root, 'keep.txt'), 'later unrelated work\n');
  rollbackWorkspaceTrees(root, before, after);

  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'baseline\n');
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'later unrelated work\n');
});

test('rollback is all-or-nothing when later work touched a turn path', () => {
  const root = repo();
  const before = captureWorkspaceTree(root);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'agent change\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'agent file\n');
  const after = captureWorkspaceTree(root);

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'later change on same path\n');
  assert.throws(
    () => rollbackWorkspaceTrees(root, before, after),
    /более поздняя работа изменила tracked\.txt/i,
  );
  // Conflict is detected before writes: the other turn's file and this turn's
  // new file are both untouched.
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'later change on same path\n');
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'agent file\n');
});
