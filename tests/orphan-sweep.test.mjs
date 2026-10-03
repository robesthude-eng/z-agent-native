import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-orphan-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const { sweepOrphanSessionData } = await import('../server/native/orphan-sweep.mjs');

test('deleteChat removes the chat rows and its workspace', () => {
  store.createUser('del@example.com', 'hash');
  store.createChat('ses_Del1', 'del@example.com', 'x');
  const ws = store.workspaceFor('ses_Del1');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  assert.equal(store.deleteChat('ses_Del1', 'del@example.com'), true);
  assert.equal(fs.existsSync(ws), false);
  assert.equal(store.getChat('ses_Del1', 'del@example.com'), null);
});

test('startup sweep removes leftovers of deleted chats and keeps live ones', () => {
  store.createUser('sweep@example.com', 'hash');
  store.createChat('ses_Live1', 'sweep@example.com', 'live');
  const data = process.env.Z_AGENT_DATA_DIR;
  const wsRoot = process.env.Z_AGENT_WORKSPACES_DIR;
  for (const dir of ['durable-jobs', 'project-context', 'turn-results']) fs.mkdirSync(path.join(data, dir), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, 'ses_Gone1', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(data, 'project-context', 'ses_Gone1.json'), '{}');
  fs.writeFileSync(path.join(data, 'project-context', 'ses_Live1.json'), '{}');
  fs.writeFileSync(path.join(data, 'durable-jobs', 'ses_Gone1.json'), '{}');
  fs.mkdirSync(path.join(data, 'turn-results', 'ses_Gone1'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'README-not-a-session'), 'keep');

  const removed = sweepOrphanSessionData();
  assert.equal(removed, 4);
  assert.equal(fs.existsSync(path.join(wsRoot, 'ses_Gone1')), false);
  assert.equal(fs.existsSync(path.join(wsRoot, 'ses_Live1')), true);
  assert.equal(fs.existsSync(path.join(data, 'project-context', 'ses_Live1.json')), true);
  assert.equal(fs.existsSync(path.join(wsRoot, 'README-not-a-session')), true);
});
