import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-capacity-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_SECRET_KEY = 'aa'.repeat(32);
process.env.Z_AGENT_AUDIT_KEY = 'bb'.repeat(32);
const store = await import(`../server/native/store.mjs?capacity=${Date.now()}`);

test.after(() => {
  try { store.closeStore(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

function seed() {
  for (const email of ['a@example.test', 'b@example.test']) {
    if (!store.getUser(email)) store.createUser(email, 'hash');
  }
  for (const [sid, owner] of [['ses_CapA1','a@example.test'],['ses_CapA2','a@example.test'],['ses_CapB1','b@example.test']]) {
    if (!store.getChat(sid, owner)) store.createChat(sid, owner, sid);
  }
}

test('shared turn capacity enforces owner and global concurrency atomically', () => {
  seed();
  assert.equal(store.reserveTurnCapacity('ses_CapA1', 'a@example.test', { maxGlobal: 2, maxPerOwner: 1, ttlMs: 60_000, now: 1_000 }).ok, true);
  const ownerDenied = store.reserveTurnCapacity('ses_CapA2', 'a@example.test', { maxGlobal: 2, maxPerOwner: 1, ttlMs: 60_000, now: 1_001 });
  assert.deepEqual(ownerDenied.reason, 'owner_limit');
  assert.equal(store.reserveTurnCapacity('ses_CapB1', 'b@example.test', { maxGlobal: 2, maxPerOwner: 1, ttlMs: 60_000, now: 1_002 }).ok, true);
  store.releaseTurnCapacity('ses_CapA1');
  assert.equal(store.reserveTurnCapacity('ses_CapA2', 'a@example.test', { maxGlobal: 2, maxPerOwner: 1, ttlMs: 60_000, now: 1_003 }).ok, true);
});

test('expired leases are reclaimed and active leases can be renewed', () => {
  seed();
  store.releaseTurnCapacity('ses_CapA2');
  store.releaseTurnCapacity('ses_CapB1');
  assert.equal(store.reserveTurnCapacity('ses_CapA1', 'a@example.test', { maxGlobal: 1, maxPerOwner: 1, ttlMs: 30_000, now: 100 }).ok, true);
  assert.equal(store.renewTurnCapacity('ses_CapA1', { ttlMs: 30_000, now: 10_000 }), true);
  assert.equal(store.turnCapacityCounts('a@example.test', 20_000).global, 1);
  assert.equal(store.turnCapacityCounts('a@example.test', 50_001).global, 0);
  assert.equal(store.reserveTurnCapacity('ses_CapB1', 'b@example.test', { maxGlobal: 1, maxPerOwner: 1, ttlMs: 30_000, now: 50_002 }).ok, true);
});
