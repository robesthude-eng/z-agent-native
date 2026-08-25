import test from 'node:test';
import assert from 'node:assert/strict';

process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
process.env.Z_AGENT_NETWORK_POLICY = 'off';
process.env.Z_AGENT_SSH_POLICY = 'off';

const { runtimeCapabilities } = await import('../server/native/runtime-capabilities.mjs');

test('runtime capability snapshot is fail-closed and does not expose allowlist values', () => {
  process.env.Z_AGENT_NETWORK_ALLOWLIST = 'secret.example.com';
  process.env.Z_AGENT_SSH_ALLOWLIST = 'private.example.com';
  const snapshot = runtimeCapabilities();
  assert.equal(snapshot.capabilities.web.state, 'disabled');
  assert.equal(snapshot.capabilities.ssh.state, 'disabled');
  assert.equal(snapshot.capabilities.web.allowlistCount, 1);
  assert.equal(snapshot.capabilities.ssh.allowlistCount, 1);
  assert.ok(!snapshot.tools.includes('webfetch'));
  assert.ok(!snapshot.tools.includes('websearch'));
  assert.ok(!snapshot.tools.includes('ssh_tool'));
  assert.ok(!snapshot.tools.includes('ensure_environment'));
  assert.doesNotMatch(JSON.stringify(snapshot), /secret\.example\.com|private\.example\.com/);
});
