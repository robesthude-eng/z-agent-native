import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function cookieJar(response) {
  const raw = response.headers.get('set-cookie') || '';
  const map = new Map();
  for (const chunk of raw.split(/,(?=\s*[^;,]+=)/)) {
    const pair = chunk.trim().split(';', 1)[0];
    const i = pair.indexOf('=');
    if (i > 0) map.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return map;
}

test('native HTTP runtime boots and owns auth/session/workspace without an external agent server', async (t) => {
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-http-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Z Agent test</title>');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: { ...process.env, PORT: String(port), Z_AGENT_DATA_DIR: path.join(root, 'data'), Z_AGENT_WORKSPACES_DIR: path.join(root, 'workspaces'), Z_AGENT_DIST_DIR: dist, Z_AGENT_SECURE_COOKIES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  t.after(() => { child.kill('SIGTERM'); });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
    if (i === 79) assert.fail(`runtime did not boot: ${stderr}`);
  }

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.runtime, 'z-agent-native');

  const register = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
  });
  assert.equal(register.status, 200);
  const cookies = cookieJar(register);
  assert.ok(cookies.get('z_agent_session'));
  assert.ok(cookies.get('z_agent_csrf'));
  const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrf = cookies.get('z_agent_csrf');

  const create = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Native smoke' }),
  });
  assert.equal(create.status, 200);
  const session = await create.json();
  assert.match(session.id, /^ses_/);

  const write = await fetch(`${base}/api/workspace/file?sessionId=${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'project/hello.txt', content: 'native workspace' }),
  });
  assert.equal(write.status, 200, await write.text());

  const file = await fetch(`${base}/api/file/content?sessionId=${encodeURIComponent(session.id)}&path=${encodeURIComponent('project/hello.txt')}`, { headers: { cookie } });
  assert.equal(file.status, 200);
  const loaded = await file.json();
  assert.equal(loaded.content, 'native workspace');

  for (const [filePath, content] of [
    ['index.html', '<!doctype html><link rel="stylesheet" href="style.css"><script src="app.js"></script><main>preview works</main>'],
    ['style.css', 'main { color: green; }'],
    ['app.js', 'document.documentElement.dataset.preview = "ready";'],
  ]) {
    const response = await fetch(`${base}/api/workspace/file?sessionId=${encodeURIComponent(session.id)}`, {
      method: 'PUT',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  const previewBase = `${base}/api/sandbox-proxy/${encodeURIComponent(session.id)}/~`;
  const preview = await fetch(`${previewBase}/index.html`, { headers: { cookie } });
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /preview works/);
  const csp = preview.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  const previewScript = await fetch(`${previewBase}/app.js`, { headers: { cookie } });
  assert.equal(previewScript.status, 200);
  assert.match(await previewScript.text(), /dataset\.preview/);

  const sessions = await fetch(`${base}/api/session`, { headers: { cookie } });
  assert.equal(sessions.status, 200);
  assert.equal((await sessions.json()).length, 1);

  // Multipart requests bypass the JSON helper in the browser, but must still
  // carry the same double-submit CSRF token. This is the exact contract used
  // by Composer attachments.
  const form = new FormData();
  form.append('file', new Blob(['attached through native runtime'], { type: 'text/plain' }), 'note.txt');
  const upload = await fetch(`${base}/api/workspace/upload?sessionId=${encodeURIComponent(session.id)}`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf },
    body: form,
  });
  const uploadBody = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(uploadBody));
  const uploaded = uploadBody;
  assert.equal(uploaded.workspacePath, 'uploads/note.txt');

  const uploadedRead = await fetch(`${base}/api/file/content?sessionId=${encodeURIComponent(session.id)}&path=${encodeURIComponent(uploaded.workspacePath)}`, { headers: { cookie } });
  assert.equal(uploadedRead.status, 200);
  assert.equal((await uploadedRead.json()).content, 'attached through native runtime');

  const deleteWorkspaceRoot = await fetch(`${base}/api/workspace/file?sessionId=${encodeURIComponent(session.id)}&path=.`, {
    method: 'DELETE',
    headers: { cookie, 'x-csrf-token': csrf },
  });
  assert.equal(deleteWorkspaceRoot.status, 400);
  assert.equal(fs.existsSync(path.join(root, 'workspaces', session.id, 'project', 'hello.txt')), true);

  const unknownProvider = await fetch(`${base}/api/auth/not-a-provider`, {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'should-not-be-stored' }),
  });
  assert.equal(unknownProvider.status, 404);

  // Browser permission cards no longer exist. The former response route must
  // stay absent rather than silently reintroducing a second execution gate.
  const legacyPermission = await fetch(`${base}/api/session/${encodeURIComponent(session.id)}/permissions/perm_missing`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'once' }),
  });
  assert.equal(legacyPermission.status, 404);

  const invalidQueue = await fetch(`${base}/api/session/${session.id}/queue`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: '', payload: { text: 'lost', attachments: [] } }),
  });
  assert.equal(invalidQueue.status, 400);
  const queued = await fetch(`${base}/api/session/${session.id}/queue`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({
      actionId: 'act_httpqueue1',
      payload: {
        text: '',
        attachments: [{ name: 'note.txt', workspacePath: 'uploads/note.txt' }],
      },
    }),
  });
  assert.equal(queued.status, 200, await queued.text());
  const queueList = await fetch(`${base}/api/session/${session.id}/queue`, {
    headers: { cookie },
  });
  assert.equal(queueList.status, 200);
  assert.equal((await queueList.json()).queue[0].actionId, 'act_httpqueue1');

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf },
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
});
