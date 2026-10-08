import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-recovery-settle-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const { activeTurns } = await import('../server/native/agent/state.mjs');
const { settleFailedRecovery } = await import('../server/native/agent/recovery.mjs');

const ownerId = 'settle@example.com';
store.createUser(ownerId, 'hash');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function seed(sid, turnId) {
  store.createChat(sid, ownerId, 'Settle');
  store.setTurn(sid, { turnId, lifecycle: 'running', verdict: null, reason: 'runtime_resume', since: Date.now() });
  const assistant = {
    id: `msg_assistant${sid.slice(4)}`,
    role: 'assistant',
    sessionID: sid,
    parts: [],
    time: { created: Date.now() },
    info: { role: 'assistant', time: { created: Date.now() } },
  };
  store.putMessage(assistant);
  return assistant;
}

test('a recovery that failed during setup releases the session and fails the turn', () => {
  const sid = 'ses_settlefail1';
  const assistant = seed(sid, 'turn_settlefail1');
  activeTurns.set(sid, { controller: new AbortController(), turnId: 'turn_settlefail1', ownerId });

  settleFailedRecovery({ sessionId: sid, turnId: 'turn_settlefail1' }, assistant, new Error('boom'));

  assert.equal(activeTurns.has(sid), false);
  assert.equal(store.getTurn(sid).lifecycle, 'failed');
  const saved = store.listMessages(sid).find((m) => m.id === assistant.id);
  assert.equal(saved.info.finish, 'error');
  assert.equal(saved.info.error.message, 'boom');
  assert.ok(saved.time.completed);
});

test('cleanup never touches a newer turn that took over the session', () => {
  const sid = 'ses_settlenewer1';
  const assistant = seed(sid, 'turn_settlenewer_new');
  activeTurns.set(sid, { controller: new AbortController(), turnId: 'turn_settlenewer_new', ownerId });

  settleFailedRecovery({ sessionId: sid, turnId: 'turn_settlenewer_old' }, assistant, new Error('late'));

  assert.equal(activeTurns.get(sid)?.turnId, 'turn_settlenewer_new');
  assert.equal(store.getTurn(sid).lifecycle, 'running');
  activeTurns.delete(sid);
});
