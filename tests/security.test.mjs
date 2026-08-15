import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeWorkspacePath, assertSafeExternalUrl } from '../server/native/security.mjs';

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

test('SSRF guard rejects local and credentialed URLs before fetch', async () => {
  await assert.rejects(() => assertSafeExternalUrl('http://127.0.0.1:3000/private'), /локаль|служеб/i);
  await assert.rejects(() => assertSafeExternalUrl('http://169.254.169.254/latest/meta-data'), /локаль|служеб/i);
  await assert.rejects(() => assertSafeExternalUrl('https://user:pass@example.com/x'), /Credentials/i);
});
