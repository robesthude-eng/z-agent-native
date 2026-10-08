import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-share-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
const store = await import('../server/native/store.mjs');
const { publicChatView } = await import('../server/native/share-view.mjs');
const { parseMeminfo, readHostStatus, systemStatus } = await import('../server/native/system-status.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const owner = 'share@example.com';
store.createUser(owner, 'hash');
const other = 'other@example.com';
store.createUser(other, 'hash');

test('share link: create is idempotent, resolves, revokes, owner-scoped', () => {
  const chat = store.createChat('ses_share1', owner, 'Публичный чат');
  const a = store.createChatShare(chat.id, owner);
  const b = store.createChatShare(chat.id, owner);
  assert.equal(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(store.resolveChatShare(a.token)?.sessionId, chat.id);
  assert.equal(store.getChatShare(chat.id, other), null);
  assert.equal(store.deleteChatShare(chat.id, other), false);
  assert.equal(store.listChatShares(owner).length, 1);
  assert.equal(store.resolveChatShare('../etc'), null);
  assert.equal(store.deleteChatShare(chat.id, owner), true);
  assert.equal(store.resolveChatShare(a.token), null);
});

test('share link disappears with the chat', () => {
  const chat = store.createChat('ses_share2', owner, 'X');
  const s = store.createChatShare(chat.id, owner);
  store.deleteChat(chat.id, owner);
  assert.equal(store.resolveChatShare(s.token), null);
});

test('public view exposes only text and tool names', () => {
  const chat = store.createChat('ses_share3', owner, 'Вид');
  store.putMessage({
    id: 'msg_1',
    sessionID: chat.id,
    role: 'user',
    parts: [
      { type: 'text', text: 'привет' },
      { type: 'text', text: 'скрыто', synthetic: true },
    ],
  });
  store.putMessage({
    id: 'msg_2',
    sessionID: chat.id,
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'секретные мысли' },
      { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'cat .env' }, output: 'API_KEY=xxx' } },
      { type: 'text', text: 'готово' },
    ],
  });
  const share = store.resolveChatShare(store.createChatShare(chat.id, owner).token);
  const view = publicChatView(share);
  const json = JSON.stringify(view);
  assert.equal(view.title, 'Вид');
  assert.equal(view.messages.length, 2);
  assert.deepEqual(view.messages[1].parts, [
    { type: 'tool', tool: 'bash', status: 'done' },
    { type: 'text', text: 'готово' },
  ]);
  for (const leak of ['скрыто', 'секретные', 'cat .env', 'API_KEY']) assert.ok(!json.includes(leak), leak);
});

test('system status: meminfo parsing and host file staleness', () => {
  const mem = parseMeminfo('MemTotal:       4000 kB\nMemFree: 100 kB\nMemAvailable:   1000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
  assert.equal(mem.total, 4000 * 1024);
  assert.equal(mem.used, 3000 * 1024);
  const f = path.join(root, 'host.json');
  fs.writeFileSync(f, JSON.stringify({ generatedAt: 1000, containers: [] }));
  assert.equal(readHostStatus(f, 2000).stale, false);
  assert.equal(readHostStatus(f, 1000 + 10 * 60_000).stale, true);
  assert.equal(readHostStatus(path.join(root, 'missing.json')), null);
  const s = systemStatus({ activeTurns: 2 });
  assert.equal(s.app.activeTurns, 2);
  assert.ok(s.memory.total > 0);
  assert.ok(s.disk.total > 0);
});
