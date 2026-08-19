import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-context-noshell-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
delete process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL;

const context = await import('../server/native/context.mjs');
const sandbox = await import('../server/native/sandbox.mjs');
const store = await import('../server/native/store.mjs');

test('read-back satisfies the no-shell completion gate without claiming executable verification', {
  skip: sandbox.shellSandboxAvailable(),
}, () => {
  const strategy = context.createTurnStrategy('Update a config file');
  context.observeTool(strategy, { name: 'edit', arguments: { path: 'config.json' } }, { isError: false });
  assert.equal(strategy.needsVerification, true);
  assert.match(context.completionGate(strategy) || '', /config\.json/);

  context.observeTool(strategy, { name: 'read', arguments: { path: 'config.json' } }, { isError: false });
  assert.equal(strategy.needsVerification, false);
  assert.equal(strategy.verificationUnavailable, true);
  assert.equal(strategy.lastVerificationOk, null);
  assert.equal(context.completionGate(strategy), null);
  assert.match(context.strategyGuidance(strategy), /executable verification was unavailable/i);
});

test.after(() => {
  store.closeStore();
  fs.rmSync(root, { recursive: true, force: true });
});
