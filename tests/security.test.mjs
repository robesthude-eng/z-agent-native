import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeWorkspacePath,
  assertSafeExternalUrl,
  safeExternalFetch,
  setExternalFetchTransportForTests,
} from '../server/native/security.mjs';

test('workspace resolver blocks traversal and symlink escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-security-'));
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
  assert.equal(safeWorkspacePath(root, 'ok.txt', { allowMissing: false }), path.join(root, 'ok.txt'));
  assert.throws(() => safeWorkspacePath(root, '../outside.txt'), /workspace|предел/i);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-outside-'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => safeWorkspacePath(root, 'link/x.txt'), /Symlink/i);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});

test('absolute /tmp paths are rewritten into the workspace instead of rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-security-tmp-'));
  fs.writeFileSync(path.join(root, 'checkers.js'), 'ok');
  assert.equal(safeWorkspacePath(root, '/tmp/checkers.js', { allowMissing: false }), path.join(root, 'checkers.js'));
  assert.equal(safeWorkspacePath(root, 'file:///tmp/checkers.js', { allowMissing: false }), path.join(root, 'checkers.js'));
  assert.throws(() => safeWorkspacePath(root, '/etc/passwd'), /относительные пути/i);
  assert.throws(() => safeWorkspacePath(root, '/tmp/../etc/passwd'), /workspace|предел/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('SSRF guard rejects local and credentialed URLs before fetch', async () => {
  await assert.rejects(() => assertSafeExternalUrl('http://127.0.0.1:3000/private'), /локаль|служеб/i);
  await assert.rejects(() => assertSafeExternalUrl('http://169.254.169.254/latest/meta-data'), /локаль|служеб/i);
  await assert.rejects(() => assertSafeExternalUrl('http://[::ffff:7f00:1]/private'), /локаль|служеб/i);
  await assert.rejects(() => assertSafeExternalUrl('http://192.0.2.10/example'), /локаль|служеб/i);
  await assert.rejects(() => assertSafeExternalUrl('http://[ff02::1]/multicast'), /локаль|служеб/i);
  await assert.rejects(() => assertSafeExternalUrl('https://user:pass@example.com/x'), /Credentials/i);
});

test('provider-style fetch uses the exact public address that passed validation', async () => {
  let seen = null;
  setExternalFetchTransportForTests(async (target) => {
    seen = target;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const response = await safeExternalFetch('https://1.1.1.1/v1/models');
    assert.equal(response.status, 200);
    assert.equal(seen?.address, '1.1.1.1');
    assert.equal(seen?.family, 4);
    assert.equal(seen?.url?.hostname, '1.1.1.1');
  } finally {
    setExternalFetchTransportForTests(null);
  }
});
