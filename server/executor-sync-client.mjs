import http from 'node:http';

const socketPath = process.env.Z_AGENT_EXECUTOR_SOCKET || '/run/z-agent-executor/executor.sock';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let payload;
try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
catch { process.stderr.write('invalid sync executor payload'); process.exit(2); }
const body = Buffer.from(JSON.stringify(payload));
const timeoutMs = Math.min(Math.max(Number(payload?.timeoutMs) || 60_000, 1_000) + 10_000, 1_810_000);
const req = http.request({ socketPath, path: '/exec', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => {
  const out = []; let size = 0;
  res.on('data', (chunk) => {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) req.destroy(new Error('executor response too large'));
    else out.push(chunk);
  });
  res.on('end', () => {
    const text = Buffer.concat(out).toString('utf8');
    if ((res.statusCode || 500) >= 400) {
      process.stderr.write(text || `executor HTTP ${res.statusCode}`);
      process.exit(3);
    }
    process.stdout.write(text || '{}');
  });
});
req.setTimeout(timeoutMs, () => req.destroy(new Error('executor sync IPC timeout')));
req.on('error', (error) => { process.stderr.write(error?.message || String(error)); process.exit(4); });
req.end(body);
