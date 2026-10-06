import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-no-replay-'));
const socket = path.join(temp, 'test.sock');
process.env.Z_AGENT_EXECUTOR_SOCKET = socket;
process.env.Z_AGENT_EXECUTOR_REQUIRED = '1';
const { executeInExecutor } = await import('../server/native/executor-client.mjs');

let requests = 0;
const server = http.createServer(async (req, res) => {
  requests += 1;
  for await (const _chunk of req) { /* drain the body */ }
  // The command "started", then the executor connection dropped before any
  // response header was written (e.g. the executor was restarted).
  res.destroy();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });

test.after(() => {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('a connection dropped after the request was sent is not replayed', async () => {
  const before = requests;
  await assert.rejects(() => executeInExecutor({ workspace: '/unused', uid: 20000, file: 'touch', args: ['x'], timeoutMs: 1000 }));
  assert.equal(requests - before, 1, 'a possibly started command must not be sent a second time');
});
