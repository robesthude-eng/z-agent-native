import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-stream-ipc-'));
const socket = path.join(temp, 'test.sock');
process.env.Z_AGENT_EXECUTOR_SOCKET = socket;
process.env.Z_AGENT_EXECUTOR_REQUIRED = '1';
const { executeInExecutor } = await import('../server/native/executor-client.mjs');
let requests = 0;
let disconnects = 0;
const timers = new Set();
const later = (fn, ms) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
};
const server = http.createServer(async (req, res) => {
  requests++;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks));
  if (input.file === 'reject') {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'identity rejected', code: 'EXECUTOR_IDENTITY_MISMATCH' }));
  }
  if (!input.streamOutput) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code: 0, stdout: 'legacy', stderr: '' }));
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.flushHeaders();
  res.on('close', () => {
    if (!res.writableEnded) disconnects++;
  });
  res.write(`${JSON.stringify({ type: 'output', stdout: 'first\n', stderr: 'warning\n' })}\n`);
  if (input.file === 'disconnect') return later(() => res.destroy(), 20);
  later(() => {
    if (!res.destroyed)
      res.end(`${JSON.stringify({ type: 'result', result: { code: 0, stdout: 'first\nlast\n', stderr: 'warning\n' } })}\n`);
  }, 150);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socket, resolve);
});
const input = { workspace: '/unused/test', uid: 20000, file: 'test', timeoutMs: 1000 };

test('IPC delivers output while running and preserves legacy JSON execution', async () => {
  let finished = false;
  const frames = [];
  const result = await executeInExecutor({
    ...input,
    onOutput: (stdout, stderr) => {
      assert.equal(finished, false);
      frames.push({ stdout, stderr });
    },
  });
  finished = true;
  assert.deepEqual(frames, [{ stdout: 'first\n', stderr: 'warning\n' }]);
  assert.match(result.stdout, /last/);
  assert.equal((await executeInExecutor(input)).stdout, 'legacy');
});

test('IPC does not retry an accepted command after stream disconnect', async () => {
  const before = requests;
  await assert.rejects(() => executeInExecutor({ ...input, file: 'disconnect', onOutput() {} }), /disconnect|aborted/i);
  assert.equal(requests - before, 1);
});

test('IPC cancellation disconnects the running request', async () => {
  const controller = new AbortController();
  const before = disconnects;
  await assert.rejects(
    () =>
      executeInExecutor({
        ...input,
        signal: controller.signal,
        onOutput() {
          controller.abort();
        },
      }),
    { name: 'AbortError' },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(disconnects > before);
});

test('IPC preserves structured rejection even when streaming was requested', async () => {
  await assert.rejects(() => executeInExecutor({ ...input, file: 'reject', onOutput() {} }), { code: 'EXECUTOR_IDENTITY_MISMATCH' });
});

test.after(async () => {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});
