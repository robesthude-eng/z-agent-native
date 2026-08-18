import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-hardening-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
process.env.Z_AGENT_GREP_TIMEOUT_MS = '1000';
// Plain http on a private address: the relay must refuse to be used at all.
process.env.Z_AGENT_RELAY_URL = 'http://10.0.0.5';

const store = await import('../server/native/store.mjs');
const durable = await import('../server/native/durable-jobs.mjs');
const providers = await import('../server/native/providers.mjs');
const auth = await import('../server/native/auth.mjs');
const environment = await import('../server/native/environment.mjs');
const { compactFrames } = await import('../server/native/context.mjs');
const { executeTool } = await import('../server/native/tools.mjs');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('an http or private relay URL is refused instead of silently proxying provider traffic', () => {
  assert.deepEqual(providers.relayStatus(), { enabled: false, host: null });
});

test('each chat receives its own sandbox uid', () => {
  store.createUser('h@example.com', 'hash');
  store.createChat('ses_hardening1', 'h@example.com', 'One');
  store.createChat('ses_hardening2', 'h@example.com', 'Two');
  const first = store.getSandboxUid('ses_hardening1');
  const second = store.getSandboxUid('ses_hardening2');
  assert.ok(first);
  assert.ok(second);
  assert.notDeepEqual(first, second);
});

test('a client supplied future timestamp cannot pin a message to the end of history', () => {
  store.putMessage({
    id: 'msg_future', sessionID: 'ses_hardening1', role: 'user',
    parts: [{ type: 'text', text: 'from the future' }], time: { created: Date.now() + 600_000 }, info: {},
  });
  store.putMessage({
    id: 'msg_now', sessionID: 'ses_hardening1', role: 'user',
    parts: [{ type: 'text', text: 'now' }], time: { created: Date.now() }, info: {},
  });
  const texts = store.listMessages('ses_hardening1').map((message) => message.parts[0].text);
  assert.deepEqual(texts, ['from the future', 'now']);
});

test('a failed idempotency key can be retried but a completed one still replays', () => {
  assert.equal(store.claimAction('ses_hardening1', 'act_retry'), true);
  store.failAction('ses_hardening1', 'act_retry', new Error('boom'));
  assert.equal(store.resetAction('ses_hardening1', 'act_retry'), true);
  assert.equal(store.getAction('ses_hardening1', 'act_retry').state, 'running');
  store.completeAction('ses_hardening1', 'act_retry', { ok: true });
  assert.equal(store.resetAction('ses_hardening1', 'act_retry'), false);
  assert.equal(store.getAction('ses_hardening1', 'act_retry').state, 'completed');
});

test('restart recovery leaves resumable sessions untouched', () => {
  store.setTurn('ses_hardening1', { turnId: 'trn_dead', lifecycle: 'running', since: Date.now() });
  store.setTurn('ses_hardening2', { turnId: 'trn_resumable', lifecycle: 'waiting_permission', since: Date.now() });
  store.createQuestion('que_hardening', 'ses_hardening2', [{ question: 'Continue?' }]);
  store.createPermission('per_hardening', 'ses_hardening2', 'bash', { command: 'true' });

  const failed = store.recoverInterruptedRuntimeState({ skipSessionIds: ['ses_hardening2'] });

  assert.equal(failed, 1);
  assert.equal(store.getTurn('ses_hardening1').lifecycle, 'failed');
  assert.equal(store.getTurn('ses_hardening2').lifecycle, 'waiting_permission');
  assert.equal(store.listPendingQuestions('ses_hardening2').length, 1);
  assert.ok(!store.getPermission('per_hardening').response);
});

test('a crashed durable turn stops blocking its session after the TTL', () => {
  durable.createDurableJob({ sessionId: 'ses_hardeningjob', ownerId: 'h@example.com' });
  assert.throws(() => durable.createDurableJob({ sessionId: 'ses_hardeningjob' }), /already exists/);

  const file = path.join(process.env.Z_AGENT_DATA_DIR, 'durable-jobs', 'ses_hardeningjob.json');
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  job.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  job.updatedAt = job.createdAt;
  fs.writeFileSync(file, JSON.stringify(job));

  durable.createDurableJob({ sessionId: 'ses_hardeningjob', ownerId: 'h@example.com' });
  assert.ok(durable.listDurableJobs().some((entry) => entry.sessionId === 'ses_hardeningjob'));
});

test('expired durable job files are pruned', () => {
  const dir = path.join(process.env.Z_AGENT_DATA_DIR, 'durable-jobs');
  fs.mkdirSync(dir, { recursive: true });
  const stale = Date.now() - 72 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(dir, 'ses_hardeningstale.json'), JSON.stringify({ version: 1, sessionId: 'ses_hardeningstale', createdAt: stale, updatedAt: stale, state: 'running' }));

  assert.ok(durable.pruneExpiredDurableJobs(60 * 60 * 1000) >= 1);
  assert.ok(!durable.listDurableJobs().some((entry) => entry.sessionId === 'ses_hardeningstale'));
});

test('registration is closed once the bootstrap admin exists', { skip: (process.env.Z_AGENT_INVITE_CODE || process.env.Z_AGENT_ALLOW_OPEN_REGISTRATION === '1') ? 'invite code or open registration configured' : false }, () => {
  if (store.userCount() === 0) store.createUser('bootstrap@example.com', 'hash');
  assert.throws(() => auth.registerUser('intruder@example.com', 'password1'), /закрыт/i);
});

test('package specs cannot smuggle VCS or URL installs', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-env-'));
  assert.throws(
    () => environment.prepareEnvironmentRequirement(workspace, { kind: 'python', packages: ['git+https://example.com/evil.git'] }),
    /Unsafe Python package spec/,
  );
  assert.ok(environment.prepareEnvironmentRequirement(workspace, { kind: 'python', packages: ['requests==2.32.5'] }));
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('one oversized frame no longer drops the whole older context', () => {
  const frames = [
    { role: 'user', content: 'oldest anchor marker' },
    { role: 'assistant', content: 'z'.repeat(400_000) },
    { role: 'user', content: 'recent one' },
    { role: 'user', content: 'recent two' },
  ];
  const compacted = compactFrames(frames, { maxChars: 20_000, maxObservationChars: 500_000 });
  const text = compacted.map((frame) => frame.content).join('\n');
  assert.match(text, /oldest anchor marker/);
  assert.match(text, /recent two/);
});

test('a catastrophic regex is cancelled by the grep deadline', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-grep-'));
  fs.writeFileSync(path.join(workspace, 'big.txt'), `${'a'.repeat(4000)}b\n`);
  const ctx = { workspace, signal: new AbortController().signal };
  await assert.rejects(
    executeTool('grep', { path: '.', query: '(a+)+$', regex: true }, ctx),
    /exceeded|cancelled/i,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});
