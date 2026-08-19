import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-result-recovery-'));
fs.chmodSync(root, 0o755); // allow the root-run per-session UID sandbox to traverse the test parent
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';

const store = await import('../server/native/store.mjs');
const events = await import('../server/native/events.mjs');
const results = await import('../server/native/turn-results.mjs');

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr || res.stdout || `git ${args.join(' ')} failed`);
  return res.stdout;
}

test('dangling Result snapshot stays open while a persisted turn is recoverable', () => {
  const ownerId = 'result-recovery@example.com';
  const sid = 'ses_resultrecovery1';
  const turnId = 'turn_resultrecovery1';
  const assistantId = 'msg_resultrecovery1';
  store.createUser(ownerId, 'hash');
  store.createChat(sid, ownerId, 'Result recovery');
  const workspace = store.workspaceFor(sid);

  git(workspace, ['init']);
  git(workspace, ['config', 'user.email', 'test@example.com']);
  git(workspace, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'before\n');
  git(workspace, ['add', 'file.txt']);
  git(workspace, ['commit', '-m', 'initial']);

  store.setTurn(sid, { turnId, lifecycle: 'running', verdict: null, reason: 'user_message', since: Date.now() });
  events.emit(sid, 'session.status', { status: 'busy' });
  store.putMessage({
    id: assistantId,
    role: 'assistant',
    sessionID: sid,
    parts: [],
    time: { created: Date.now() },
    info: { role: 'assistant', time: { created: Date.now() } },
  });
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'after\n');

  results.recoverDanglingTurnResults();
  assert.throws(() => results.getTurnResult(sid, assistantId), /нет сохранённого результата workspace/i);

  store.setTurn(sid, { turnId, lifecycle: 'failed', verdict: 'failed', reason: 'no_durable_job', since: Date.now() });
  results.recoverDanglingTurnResults();
  const result = results.getTurnResult(sid, assistantId);
  assert.equal(result.turnId, turnId);
  assert.equal(result.changeCount, 1);
  assert.deepEqual(result.changes.map((change) => change.path), ['file.txt']);
});
