import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectAuthority, resolveBrowserEgress } from '../server/native/browser-egress-policy.mjs';

test('browser egress parses CONNECT authority without accepting URL/userinfo smuggling', () => {
  assert.deepEqual(parseConnectAuthority('example.com:443'), { hostname: 'example.com', port: 443 });
  assert.deepEqual(parseConnectAuthority('[2606:4700:4700::1111]:8443'), { hostname: '2606:4700:4700::1111', port: 8443 });
  assert.throws(() => parseConnectAuthority('user@example.com:443'), /Invalid CONNECT/);
  assert.throws(() => parseConnectAuthority('example.com:443/path'), /Invalid CONNECT/);
});

test('browser egress is fail-closed by default and pins a public target only when policy allows it', async () => {
  const previous = process.env.Z_AGENT_NETWORK_POLICY;
  try {
    process.env.Z_AGENT_NETWORK_POLICY = 'off';
    await assert.rejects(resolveBrowserEgress('https://1.1.1.1/'), /disabled by Z_AGENT_NETWORK_POLICY=off/);
    process.env.Z_AGENT_NETWORK_POLICY = 'public';
    const target = await resolveBrowserEgress('https://1.1.1.1/');
    assert.equal(target.address, '1.1.1.1');
    assert.equal(target.url.protocol, 'https:');
    await assert.rejects(resolveBrowserEgress('https://127.0.0.1/'), /Локальные|служебные/);
  } finally {
    if (previous === undefined) delete process.env.Z_AGENT_NETWORK_POLICY; else process.env.Z_AGENT_NETWORK_POLICY = previous;
  }
});
