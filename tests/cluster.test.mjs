import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// Cluster mode is read from the environment when the module loads, so the whole
// setup has to happen before the dynamic import below.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-cluster-'));
fs.mkdirSync(dataDir, { recursive: true });
process.env.Z_AGENT_DATA_DIR = dataDir;
process.env.Z_AGENT_CLUSTER = '1';
process.env.Z_AGENT_INSTANCE_ID = 'node-a';
// Long poll interval: the tests drain the queue themselves, so no background
// timer can steal an event mid-assertion.
process.env.Z_AGENT_CLUSTER_POLL_MS = '60000';

const cluster = await import('../server/native/cluster.mjs');

after(() => cluster.stopCluster());

test('the turn lock admits one instance and names its holder', () => {
  const first = cluster.acquireTurnLock('ses_abc', { owner: 'msg_1' });
  assert.equal(first.ok, true);
  assert.equal(first.instanceId, 'node-a');
  assert.equal(first.takeover, false);

  const holder = cluster.turnLockHolder('ses_abc');
  assert.equal(holder.instanceId, 'node-a');
  assert.equal(holder.owner, 'msg_1');

  // Re-entrant for its own holder: durable recovery re-acquires its own lock.
  assert.equal(cluster.acquireTurnLock('ses_abc').ok, true);
  assert.equal(cluster.renewTurnLock('ses_abc'), true);
  assert.equal(cluster.releaseTurnLock('ses_abc'), true);
  assert.equal(cluster.turnLockHolder('ses_abc'), null);
});

test('a second replica cannot start a turn that is already owned', () => {
  const now = Date.now();
  assert.equal(cluster.acquireTurnLock('ses_busy', { owner: 'msg_2', now }).ok, true);
  const other = cluster.acquireTurnLock('ses_busy', { instanceId: 'node-b', now: now + 10 });
  assert.equal(other.ok, false);
  assert.equal(other.instanceId, 'node-a');
  assert.equal(other.owner, 'msg_2');
});

test('a stale lock from a dead replica is taken over after its ttl', () => {
  const now = Date.now();
  // A lock written by another replica that then stopped renewing.
  const foreign = cluster.acquireTurnLock('ses_dead', { instanceId: 'node-b', owner: 'msg_3', ttlMs: 50, now });
  assert.equal(foreign.ok, true);
  assert.equal(cluster.acquireTurnLock('ses_dead', { now: now + 10 }).ok, false);

  const takeover = cluster.acquireTurnLock('ses_dead', { owner: 'msg_4', now: now + 100 });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.takeover, true);
  assert.equal(cluster.turnLockHolder('ses_dead').owner, 'msg_4');

  // The dead replica can no longer renew or release what it lost, so a late
  // wake-up cannot delete somebody else's lock.
  assert.equal(cluster.renewTurnLock('ses_dead', { instanceId: 'node-b' }), false);
  assert.equal(cluster.releaseTurnLock('ses_dead', { instanceId: 'node-b' }), false);
  assert.equal(cluster.turnLockHolder('ses_dead').instanceId, 'node-a');
});

test('events from another replica reach local subscribers exactly once', () => {
  const seen = [];
  cluster.startCluster({ ingest: (sessionId, event) => seen.push([sessionId, event.type]) });

  cluster.publishEvent('ses_x', { type: 'local.busy', properties: {} });
  cluster.publishEvent('ses_x', { type: 'remote.busy', properties: { sessionID: 'ses_x' } }, 'node-b');

  assert.equal(cluster.pollClusterEvents(), 1);
  assert.deepEqual(seen, [['ses_x', 'remote.busy']]);
  // The cursor advanced, so draining again delivers nothing twice.
  assert.equal(cluster.pollClusterEvents(), 0);
  assert.deepEqual(seen, [['ses_x', 'remote.busy']]);
});

test('replicas register themselves with a heartbeat', () => {
  cluster.touchInstance();
  const self = cluster.listInstances().find((instance) => instance.self);
  assert.equal(self.id, 'node-a');
  assert.equal(self.alive, true);
  // A replica that stopped reporting is visible but not alive.
  const stale = cluster.listInstances(Date.now() + cluster.LOCK_TTL_MS * 4).find((instance) => instance.self);
  assert.equal(stale.alive, false);
});

test('the catch-up queue is pruned instead of growing forever', () => {
  cluster.publishEvent('ses_y', { type: 'old.frame', properties: {} }, 'node-b');
  assert.ok(cluster.pruneEvents(Date.now() + 1000) >= 1);
  assert.equal(cluster.pollClusterEvents(), 0);
});
