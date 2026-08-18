import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-terminal-test-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
const store = await import('../server/native/store.mjs');
const { sameOrigin } = await import('../server/native/terminal.mjs');

test('terminal websocket accepts same-origin handshakes and rejects everything else', () => {
  assert.equal(sameOrigin({ headers: { host: 'agent.example', origin: 'https://agent.example' } }), true);
  assert.equal(sameOrigin({ headers: { host: 'agent.example', origin: 'https://evil.example' } }), false);
  assert.equal(sameOrigin({ headers: { host: 'localhost:3000', origin: 'not a url' } }), false);
});

test('terminal websocket rejects handshakes without an Origin header', () => {
  // A missing Origin is the signature of a non-browser client; accepting it made
  // a stolen session cookie sufficient to open a shell.
  assert.equal(sameOrigin({ headers: { host: 'localhost:3000' } }), false);
  assert.equal(sameOrigin({ headers: {} }), false);
});

test.after(() => {
  store.closeStore();
  fs.rmSync(root, { recursive: true, force: true });
});
