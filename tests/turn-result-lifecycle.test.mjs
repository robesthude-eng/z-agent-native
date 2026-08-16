import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-turn-lifecycle-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const events = await import('../server/native/events.mjs');
const results = await import('../server/native/turn-results.mjs');

function git(workspace, args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
}

test('runtime lifecycle binds an exact workspace result to the assistant message', () => {
  const ownerId = 'turn-result@example.com';
  const sessionId = 'ses_Lifecycle1';
  const turnId = 'turn_Lifecycle1';
  const assistantId = 'msg_Lifecycle1';

  store.createUser(ownerId, 'test-hash');
  store.createChat(sessionId, ownerId, 'Lifecycle result');
  const workspace = store.workspaceFor(sessionId);
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'tests@example.com']);
  git(workspace, ['config', 'user.name', 'Z Agent Tests']);
  fs.writeFileSync(path.join(workspace, 'app.txt'), 'before\n');
  git(workspace, ['add', '.']);
  git(workspace, ['commit', '-qm', 'baseline']);

  store.setTurn(sessionId, {
    turnId,
    lifecycle: 'running',
    verdict: null,
    reason: 'test',
    since: Date.now(),
  });
  events.emit(sessionId, 'session.status', { status: 'busy' });

  fs.writeFileSync(path.join(workspace, 'app.txt'), 'after\n');
  fs.writeFileSync(path.join(workspace, 'new.txt'), 'created by turn\n');
  const completed = Date.now();
  store.putMessage({
    id: assistantId,
    role: 'assistant',
    sessionID: sessionId,
    parts: [{ id: 'prt_Lifecycle1', type: 'text', text: 'Готово' }],
    time: { created: completed - 10, completed },
    info: {
      role: 'assistant',
      finish: 'stop',
      outcome: { status: 'completed' },
      strategy: { changed: true },
      time: { created: completed - 10, completed },
    },
  });
  events.emit(sessionId, 'session.status', { status: 'idle' });

  const result = results.getTurnResult(sessionId, assistantId);
  assert.equal(result.turnId, turnId);
  assert.equal(result.messageId, assistantId);
  assert.deepEqual(result.changes.map((row) => [row.status, row.path]), [
    ['modified', 'app.txt'],
    ['added', 'new.txt'],
  ]);

  const patch = results.getTurnResultDiff(sessionId, assistantId, 'app.txt');
  assert.match(patch.patch, /-before/);
  assert.match(patch.patch, /\+after/);

  const rollback = results.rollbackTurnResult(sessionId, assistantId);
  assert.deepEqual(new Set(rollback.restored), new Set(['app.txt', 'new.txt']));
  assert.equal(fs.readFileSync(path.join(workspace, 'app.txt'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(path.join(workspace, 'new.txt')), false);
  assert.ok(results.getTurnResult(sessionId, assistantId).rolledBackAt);

  events.clearSessionEvents(sessionId);
  store.deleteChat(sessionId, ownerId);
});

test.after(() => {
  try { store.closeStore(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
