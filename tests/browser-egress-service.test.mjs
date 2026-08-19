import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitListening(child, timeoutMs = 3000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser egress start timeout')), timeoutMs);
    const onData = (chunk) => {
      if (!String(chunk).includes('[browser-egress] listening')) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`browser egress exited early: ${code}`)); });
  });
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('health timeout')));
  });
}

function connectAttempt(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(1500, () => socket.destroy(new Error('CONNECT timeout')));
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); if (data.includes('\r\n\r\n')) socket.end(); });
    socket.on('end', () => resolve(data));
    socket.on('close', () => { if (data) resolve(data); });
    socket.on('error', reject);
  });
}

test('browser egress service stays healthy while policy=off and denies CONNECT before outbound dialing', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/browser-egress.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, Z_AGENT_BROWSER_EGRESS_HOST: '127.0.0.1', Z_AGENT_BROWSER_EGRESS_PORT: String(port), Z_AGENT_NETWORK_POLICY: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitListening(child);
    const health = await getHealth(port);
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).policyProxy, true);
    const response = await connectAttempt(port, '1.1.1.1:443');
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/m);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
