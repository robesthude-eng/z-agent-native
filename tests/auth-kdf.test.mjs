import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// auth.mjs imports the store, so isolate this test before the dynamic import.
// Unit tests must never create or mutate the repository's ./data directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-auth-kdf-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_SECRET_KEY = Buffer.alloc(32, 0x41).toString('hex');
process.env.Z_AGENT_AUDIT_KEY = Buffer.alloc(32, 0x42).toString('hex');

const { hashPassword, passwordHashNeedsUpgrade, verifyPassword } = await import('../server/native/auth.mjs');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function legacyHash(password) {
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

test('new password hashes are versioned and stronger than the legacy format', () => {
  const encoded = hashPassword('correct horse battery staple');
  assert.match(encoded, /^scrypt\$v2\$32768\$8\$1\$/);
  assert.equal(verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(verifyPassword('wrong password', encoded), false);
  assert.equal(passwordHashNeedsUpgrade(encoded), false);
});

test('legacy scrypt hashes remain verifiable but are marked for opportunistic rehash', () => {
  const encoded = legacyHash('legacy password with length');
  assert.equal(verifyPassword('legacy password with length', encoded), true);
  assert.equal(passwordHashNeedsUpgrade(encoded), true);
});

test('malformed or resource-amplifying password hashes fail closed', () => {
  assert.equal(verifyPassword('x', 'scrypt$v2$1048576$32$16$AA$AA'), false);
  assert.equal(verifyPassword('x', 'scrypt$v2$32768$8$1$not-base64$not-base64'), false);
  assert.equal(verifyPassword('x', 'argon2$whatever'), false);
});
