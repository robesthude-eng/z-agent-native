import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Env must be set before the modules are imported: both read it at load time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-cluster-turn-'));
process.env.Z_AGENT_DATA_DIR = dir;
process.env.Z_AGENT_CLUSTER = '1';
process.env.Z_AGENT_INSTANCE_ID = 'node-a';
process.env.Z_AGENT_CLUSTER_POLL_MS = '60000';

const cluster = await import('../server/native/cluster.mjs');
const agent = await import('../server/native/agent.mjs');

after(() => { cluster.stopCluster(); });

test('a session owned by another replica is refused with 409', async () => {
  const sessionId = 'ses_ownedElsewhere';
  assert.equal(cluster.acquireTurnLock(sessionId, { instanceId: 'node-b' }).ok, true);
  await assert.rejects(
    () => agent.runTurn({ sessionId, ownerId: 'usr_1', parts: [{ type: 'text', text: 'hi' }], model: 'test/model', system: '' }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.holder, 'node-b');
      return true;
    },
  );
  // The refusal must not steal the claim from the node that is working.
  assert.equal(cluster.turnLockHolder(sessionId).instanceId, 'node-b');
  assert.equal(agent.isTurnActive(sessionId), false);
});

test('a free session can be claimed by this replica', () => {
  const sessionId = 'ses_freeToClaim';
  assert.equal(cluster.turnLockHolder(sessionId), null);
  const claim = cluster.acquireTurnLock(sessionId);
  assert.equal(claim.ok, true);
  assert.equal(claim.instanceId, 'node-a');
  assert.equal(cluster.releaseTurnLock(sessionId), true);
  assert.equal(cluster.turnLockHolder(sessionId), null);
});
