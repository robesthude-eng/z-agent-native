import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../server/native/tools.mjs';

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-nav-'));
}

test('list and glob skip heavy root vendor/generated directories', async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.ts'), 'vendor');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'git');
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'app');

  const listed = await executeTool('list', { path: '.', depth: 4 }, { workspace: root });
  assert.match(listed.output, /src\/app\.ts/);
  assert.doesNotMatch(listed.output, /node_modules/);
  assert.doesNotMatch(listed.output, /\.git/);

  const globbed = await executeTool('glob', { pattern: '**/*.ts' }, { workspace: root });
  assert.match(globbed.output, /src\/app\.ts/);
  assert.doesNotMatch(globbed.output, /node_modules/);
});

test('double-star slash glob also matches files at workspace root', async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'root.ts'), 'root');
  fs.writeFileSync(path.join(root, 'src', 'nested.ts'), 'nested');

  const result = await executeTool('glob', { pattern: '**/*.ts' }, { workspace: root });
  assert.match(result.output, /(?:^|\n)root\.ts(?:\n|$)/);
  assert.match(result.output, /src\/nested\.ts/);
});

test('read can inspect a line window from a file larger than the whole-file edit limit', async () => {
  const root = workspace();
  const file = path.join(root, 'large.txt');
  const lines = Array.from({ length: 8000 }, (_, i) => `${String(i + 1).padStart(5, '0')} ${'x'.repeat(90)}`);
  fs.writeFileSync(file, lines.join('\n'));
  assert.ok(fs.statSync(file).size > 512 * 1024);

  const result = await executeTool('read', { path: 'large.txt', offset: 7000, limit: 3 }, { workspace: root });
  assert.match(result.output, /^7001: 07001 /);
  assert.match(result.output, /7003: 07003 /);
});
