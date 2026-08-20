import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-tools-runtime-'));
process.env.Z_AGENT_DATA_DIR = path.join(runtimeRoot, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(runtimeRoot, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const { executeTool } = await import('../server/native/tools.mjs');
test.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

test('native file tools read/write/edit/grep/list inside one workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-tools-'));
  const ctx = { workspace: root, signal: new AbortController().signal };
  const written = await executeTool('write', { path: 'src/a.txt', content: 'hello\nworld\n' }, ctx);
  assert.deepEqual(written.mutatedPaths, ['src/a.txt']);
  const read = await executeTool('read', { path: 'src/a.txt' }, ctx);
  assert.match(read.output, /1: hello/);
  await executeTool('edit', { path: 'src/a.txt', oldText: 'world', newText: 'agent' }, ctx);
  assert.equal(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8'), 'hello\nagent\n');
  const grep = await executeTool('grep', { path: '.', query: 'agent' }, ctx);
  assert.match(grep.output, /src\/a\.txt:2/);
  const list = await executeTool('list', { path: '.', depth: 3 }, ctx);
  assert.match(list.output, /src\/a\.txt/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bash runs in workspace with no provider secrets injected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-bash-'));
  process.env.OPENAI_API_KEY = 'must-not-leak';
  const result = await executeTool('bash', { command: 'pwd; printf "key=%s" "${OPENAI_API_KEY:-}"' }, { workspace: root, signal: new AbortController().signal });
  assert.equal(result.metadata?.exit, 0);
  assert.match(result.output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.output, /key=$/m);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bash abort escalates to SIGKILL when a child ignores SIGTERM', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-bash-stop-'));
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = executeTool('bash', {
    command: `node -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
    timeoutMs: 8000,
  }, { workspace: root, signal: controller.signal });

  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  const result = await running;
  const elapsed = Date.now() - startedAt;

  assert.equal(result.metadata?.exit, 130);
  assert.ok(elapsed < 4000, `abort took ${elapsed}ms; expected forced termination well before the 8s tool timeout`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('apply_patch changes workspace files and rejects traversal paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-patch-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  const ctx = { workspace: root, signal: new AbortController().signal };
  const patch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-hello\n+world\n`;
  const result = await executeTool('apply_patch', { patch }, ctx);
  assert.deepEqual(result.mutatedPaths, ['.']);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'world\n');
  const unsafe = `--- a/../escape.txt\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+x\n`;
  await assert.rejects(() => executeTool('apply_patch', { patch: unsafe }, ctx), /Unsafe patch path/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('write maps /tmp into the workspace so a stray absolute path still lands in the project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-tmpwrite-'));
  const ctx = { workspace: root, signal: new AbortController().signal };
  const written = await executeTool('write', { path: '/tmp/checkers.js', content: 'export const ok = true;\n' }, ctx);
  assert.deepEqual(written.mutatedPaths, ['checkers.js']);
  assert.equal(fs.readFileSync(path.join(root, 'checkers.js'), 'utf8'), 'export const ok = true;\n');
  const read = await executeTool('read', { path: '/tmp/checkers.js' }, ctx);
  assert.match(read.output, /export const ok/);
  await assert.rejects(() => executeTool('write', { path: '/etc/passwd', content: 'nope' }, ctx), /относительные пути/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('todowrite returns structured plan metadata without touching workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-todo-'));
  const result = await executeTool('todowrite', { todos: [
    { content: 'Inspect project', status: 'completed' },
    { content: 'Run tests', status: 'in_progress', priority: 'high' },
  ] }, { workspace: root, signal: new AbortController().signal });
  assert.match(result.output, /\[completed\] Inspect project/);
  assert.equal(result.metadata.todos[1].status, 'in_progress');
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});
