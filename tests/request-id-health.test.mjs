import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test('/health/live is a cheap liveness probe and every response carries x-request-id', async (t) => {
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-reqid-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      Z_AGENT_DATA_DIR: path.join(root, 'data'),
      Z_AGENT_WORKSPACES_DIR: path.join(root, 'workspaces'),
      Z_AGENT_DIST_DIR: dist,
      Z_AGENT_SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  t.after(() => {
    child.kill('SIGTERM');
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/health/live`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
    if (i === 79) assert.fail(`runtime did not boot: ${stderr}`);
  }

  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200);
  const body = await live.json();
  assert.equal(body.status, 'alive');
  assert.equal(body.runtime, 'z-agent-native');
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.match(live.headers.get('x-request-id') || '', /^[0-9a-f]{10}$/);

  // Readiness keeps working and is not the same endpoint.
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.ok((await ready.json()).checks);

  // A well-formed inbound ID is kept; a malformed one is replaced.
  const kept = await fetch(`${base}/health`, { headers: { 'x-request-id': 'abc-12345.XYZ' } });
  assert.equal(kept.headers.get('x-request-id'), 'abc-12345.XYZ');
  const replaced = await fetch(`${base}/health`, { headers: { 'x-request-id': 'bad id with spaces' } });
  assert.match(replaced.headers.get('x-request-id') || '', /^[0-9a-f]{10}$/);

  // Error responses and static files carry the header too.
  const unauth = await fetch(`${base}/api/session`);
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('x-request-id') || '', /^[0-9a-f]{10}$/);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-request-id') || '', /^[0-9a-f]{10}$/);
});
