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
  assert.equal(login.cookies.length, 4);
  assert.match(login.cookies[0], /^__Host-z_agent_session=/);
  assert.match(login.cookies[0], /; HttpOnly/);
  assert.match(login.cookies[0], /; Secure/);
  assert.match(login.cookies[0], /; Path=\//);
  assert.doesNotMatch(login.cookies[0], /; Domain=/i);
  assert.match(login.cookies[1], /^__Host-z_agent_csrf=/);
  assert.doesNotMatch(login.cookies[1], /; HttpOnly/);
  assert.match(login.cookies[1], /; Secure/);
  assert.match(login.cookies[2], /^z_agent_session=;.*Max-Age=0/);
  assert.match(login.cookies[3], /^z_agent_csrf=;.*Max-Age=0/);
});

test('CSRF prefers the __Host cookie when a leftover unprefixed cookie is also sent', () => {
  store.createUser('csrf@example.test', 'hash');
  const login = auth.issueLogin('csrf@example.test');
  const hostCsrf = login.cookies[1].split(';')[0].slice('__Host-z_agent_csrf='.length);
  const decoded = decodeURIComponent(hostCsrf);
  const req = {
    method: 'POST',
    url: '/api/session',
    headers: {
      cookie: `z_agent_csrf=stale-legacy-token-value-32chars; __Host-z_agent_session=${login.token}; __Host-z_agent_csrf=${hostCsrf}`,
      'x-csrf-token': decoded,
    },
  };
  const res = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code; }, end(body) { this.body = body; } };
  const sessionAuth = auth.authFromRequest(req);
  assert.ok(sessionAuth);
  assert.equal(auth.checkCsrf(req, res, sessionAuth), true);

  const stale = {
    method: 'POST',
    url: '/api/session',
    headers: {
      cookie: req.headers.cookie,
      'x-csrf-token': 'stale-legacy-token-value-32chars',
    },
  };
  const staleRes = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code; }, end(body) { this.body = body; } };
  assert.equal(auth.checkCsrf(stale, staleRes, sessionAuth), false);
  assert.equal(staleRes.statusCode, 403);
});
