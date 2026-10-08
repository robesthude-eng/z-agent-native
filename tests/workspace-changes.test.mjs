import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { completionGate, createTurnStrategy, observeTool } from '../server/native/context.mjs';
import { executeBashTool } from '../server/native/tools/shell.mjs';
import { compareWorkspaceSnapshots, snapshotWorkspace } from '../server/native/workspace-changes.mjs';

test('workspace change tracking observes edits, removals and renames without reading symlink targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-changes-'));
  try {
    await fs.writeFile(path.join(root, 'file.txt'), 'before');
    await fs.symlink('/not-accessible', path.join(root, 'link'));
    const before = await snapshotWorkspace(root);
    await fs.readFile(path.join(root, 'file.txt'));
    await fs.mkdir(path.join(root, '.agent-home'));
    await fs.writeFile(path.join(root, '.agent-home', 'history'), 'incidental');
    assert.deepEqual(compareWorkspaceSnapshots(before, await snapshotWorkspace(root)), { complete: true, paths: [], truncated: false });
    await fs.writeFile(path.join(root, 'file.txt'), 'updated');
    assert.deepEqual(compareWorkspaceSnapshots(before, await snapshotWorkspace(root)).paths, ['file.txt']);
    await fs.rename(path.join(root, 'file.txt'), path.join(root, 'renamed.txt'));
    assert.deepEqual(compareWorkspaceSnapshots(before, await snapshotWorkspace(root)).paths.sort(), ['file.txt', 'renamed.txt']);
    assert.equal((await snapshotWorkspace(root, { maxEntries: 1 })).complete, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real bash edits still require verification while environment inspection does not', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-changes-'));
  const prior = process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL;
  process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
  try {
    const strategy = createTurnStrategy('Inspect and update a file');
    for (const command of ['command -v node', "printf 'export const ok = true;\\n' > module.mjs"]) {
      const result = await executeBashTool(root, { command });
      observeTool(strategy, { name: 'bash', arguments: { command } }, { ...result, content: result.output, isError: false });
      if (command.startsWith('command')) {
        assert.equal(strategy.changed, false);
        assert.equal(completionGate(strategy), null);
      }
    }
    assert.equal(strategy.changed, true);
    assert.deepEqual(strategy.changedPaths, ['module.mjs']);
    assert.ok(completionGate(strategy));
  } finally {
    if (prior === undefined) delete process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL;
    else process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dependency and build folders do not make the scan incomplete', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-heavy-'));
  try {
    await fs.writeFile(path.join(root, 'index.js'), 'x');
    for (const dir of ['node_modules/pkg', 'web/node_modules/a', '.venv/lib', 'dist']) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
      for (let i = 0; i < 30; i++) await fs.writeFile(path.join(root, dir, `f${i}.js`), 'x');
    }
    const before = await snapshotWorkspace(root, { maxEntries: 20 });
    assert.equal(before.complete, true);
    await fs.writeFile(path.join(root, 'node_modules/pkg/f0.js'), 'changed');
    assert.deepEqual(compareWorkspaceSnapshots(before, await snapshotWorkspace(root, { maxEntries: 20 })).paths, []);
    await fs.writeFile(path.join(root, 'index.js'), 'changed');
    assert.deepEqual(compareWorkspaceSnapshots(before, await snapshotWorkspace(root, { maxEntries: 20 })).paths, ['index.js']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
