import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProductionPolicy } from '../server/native/config.mjs';

function secure(overrides = {}) {
  return {
    Z_AGENT_PRODUCTION: '1',
    Z_AGENT_SECURE_COOKIES: '1',
    Z_AGENT_EXECUTOR_REQUIRED: '1',
    Z_AGENT_BROWSER_REQUIRED: '1',
    Z_AGENT_TERMINAL_ENABLED: '0',
    Z_AGENT_SECRET_KEY_STRICT: '1',
    Z_AGENT_REQUIRE_EXTERNAL_KEYS: '1',
    Z_AGENT_ALLOW_UNISOLATED_SHELL: '0',
    Z_AGENT_NETWORK_POLICY: 'off',
    Z_AGENT_DATA_DIR: '/data',
    Z_AGENT_WORKSPACES_DIR: '/workspaces',
    ...overrides,
  };
}

test('secure production profile is accepted', () => {
  assert.equal(assertProductionPolicy(secure()), true);
});

test('production fails closed when a mandatory boundary is weakened', () => {
  for (const [key, value] of [
    ['Z_AGENT_SECURE_COOKIES', '0'],
    ['Z_AGENT_EXECUTOR_REQUIRED', '0'],
    ['Z_AGENT_BROWSER_REQUIRED', '0'],
    ['Z_AGENT_TERMINAL_ENABLED', '1'],
    ['Z_AGENT_SECRET_KEY_STRICT', '0'],
    ['Z_AGENT_REQUIRE_EXTERNAL_KEYS', '0'],
    ['Z_AGENT_ALLOW_UNISOLATED_SHELL', '1'],
    ['Z_AGENT_DATA_DIR', './data'],
  ]) {
    assert.throws(() => assertProductionPolicy(secure({ [key]: value })), /Unsafe production configuration/);
  }
});

test('broad public web egress needs a second explicit production opt-in', () => {
  assert.throws(() => assertProductionPolicy(secure({ Z_AGENT_NETWORK_POLICY: 'public' })), /ALLOW_PUBLIC_WEB/);
  assert.equal(assertProductionPolicy(secure({ Z_AGENT_NETWORK_POLICY: 'public', Z_AGENT_ALLOW_PUBLIC_WEB: '1' })), true);
});
