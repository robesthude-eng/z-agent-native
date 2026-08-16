import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffGitChange, listGitChanges, parsePorcelainZ, revertGitChange } from '../server/native/git-changes.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-git-result-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'tests@example.com']);
  git(root, ['config', 'user.name', 'Z Agent Tests']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n');
  fs.writeFileSync(path.join(root, 'rename-me.txt'), 'rename baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

test('parsePorcelainZ keeps rename source and destination without shell parsing', () => {
  const rows = parsePorcelainZ('R  new name.txt\0old name.txt\0?? fresh.txt\0');
  assert.deepEqual(rows, [
    { path: 'new name.txt', status: 'renamed', code: 'R ', originalPath: 'old name.txt' },
    { path: 'fresh.txt', status: 'untracked', code: '??' },
  ]);
});

test('diff shows tracked and untracked changes with line stats', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'after\nsecond\n');
  fs.writeFileSync(path.join(root, 'fresh.txt'), 'one\ntwo\n');

  const status = listGitChanges(root);
  assert.equal(status.find((row) => row.path === 'tracked.txt')?.status, 'modified');
  assert.equal(status.find((row) => row.path === 'fresh.txt')?.status, 'untracked');

  const tracked = diffGitChange(root, 'tracked.txt');
  assert.match(tracked.patch, /-before/);
  assert.match(tracked.patch, /\+after/);
  assert.equal(tracked.additions, 2);
  assert.equal(tracked.deletions, 1);

  const fresh = diffGitChange(root, 'fresh.txt');
  assert.match(fresh.patch, /--- \/dev\/null/);
  assert.match(fresh.patch, /\+one/);
  assert.equal(fresh.additions, 2);
  assert.equal(fresh.deletions, 0);
});

test('revert restores tracked files and removes untracked files', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(root, 'fresh.txt'), 'temporary\n');

  revertGitChange(root, 'tracked.txt');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'before\n');

  revertGitChange(root, 'fresh.txt');
  assert.equal(fs.existsSync(path.join(root, 'fresh.txt')), false);
  assert.deepEqual(listGitChanges(root), []);
});

test('revert of a staged rename restores the original path and removes the target', () => {
  const root = repo();
  git(root, ['mv', 'rename-me.txt', 'renamed.txt']);

  const rename = listGitChanges(root).find((row) => row.status === 'renamed');
  assert.equal(rename?.path, 'renamed.txt');
  assert.equal(rename?.originalPath, 'rename-me.txt');

  revertGitChange(root, 'renamed.txt');
  assert.equal(fs.existsSync(path.join(root, 'renamed.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'rename-me.txt'), 'utf8'), 'rename baseline\n');
  assert.deepEqual(listGitChanges(root), []);
});

test('paths outside the workspace are rejected before Git execution', () => {
  const root = repo();
  assert.throws(() => diffGitChange(root, '../outside.txt'), /workspace|path|outside|unsafe/i);
  assert.throws(() => revertGitChange(root, '/etc/passwd'), /workspace|path|outside|unsafe/i);
});
