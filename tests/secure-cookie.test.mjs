import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-secure-cookie-'));
Object.assign(process.env, {
  Z_AGENT_PRODUCTION: '1',
  Z_AGENT_SECURE_COOKIES: '1',
  Z_AGENT_EXECUTOR_REQUIRED: '1',
  Z_AGENT_BROWSER_REQUIRED: '1',
  Z_AGENT_TERMINAL_ENABLED: '0',
  Z_AGENT_SECRET_KEY_STRICT: '1',
  Z_AGENT_REQUIRE_EXTERNAL_KEYS: '1',
  Z_AGENT_ALLOW_UNISOLATED_SHELL: '0',
  Z_AGENT_NETWORK_POLICY: 'off',
  Z_AGENT_DATA_DIR: path.join(root, 'data'),
  Z_AGENT_WORKSPACES_DIR: path.join(root, 'workspaces'),
  Z_AGENT_SECRET_KEY: '91'.repeat(32),
  Z_AGENT_AUDIT_KEY: '92'.repeat(32),
});
const auth = await import(`../server/native/auth.mjs?secure-cookie=${Date.now()}`);
const store = await import('../server/native/store.mjs');

test.after(() => {
  try { store.closeStore(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

test('production login cookies use __Host prefix, Secure and expected HttpOnly split', () => {
  store.createUser('cookie@example.test', 'hash');
  const login = auth.issueLogin('cookie@example.test');
  assert.equal(login.cookies.length, 2);
  assert.match(login.cookies[0], /^__Host-z_agent_session=/);
  assert.match(login.cookies[0], /; HttpOnly/);
  assert.match(login.cookies[0], /; Secure/);
  assert.match(login.cookies[0], /; Path=\//);
  assert.doesNotMatch(login.cookies[0], /; Domain=/i);
  assert.match(login.cookies[1], /^__Host-z_agent_csrf=/);
  assert.doesNotMatch(login.cookies[1], /; HttpOnly/);
  assert.match(login.cookies[1], /; Secure/);
});
