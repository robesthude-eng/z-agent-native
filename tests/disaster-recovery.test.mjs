import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function run(args, env) {
  return spawnSync(process.execPath, args, { cwd: process.cwd(), env, encoding: 'utf8', timeout: 60_000 });
}

test('backup is accepted only after a full restore/integrity/secret/audit drill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-dr-'));
  const env = {
    ...process.env,
    Z_AGENT_DATA_DIR: path.join(root, 'data'),
    Z_AGENT_WORKSPACES_DIR: path.join(root, 'workspaces'),
    Z_AGENT_SECRET_KEY: '66'.repeat(32),
    Z_AGENT_SECRET_KEY_STRICT: '1',
    Z_AGENT_AUDIT_KEY: '77'.repeat(32),
  };
  try {
    const seed = run(['--input-type=module', '-e', `
      const s=await import('./server/native/store.mjs');
      s.createRegistrationUser('restore@example.test','test-hash',{allowAdditional:true});
      s.setProviderKey('restore@example.test','openai','sk-restorable');
      s.createChat('ses_Restore123','restore@example.test','Restore me');
      s.closeStore();
    `], env);
    assert.equal(seed.status, 0, seed.stderr || seed.stdout);

    const snapshot = path.join(root, 'backup.sqlite');
    const backup = run(['server/backup.mjs', snapshot], env);
    assert.equal(backup.status, 0, backup.stderr || backup.stdout);
    const verify = run(['server/restore-verify.mjs', snapshot], env);
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    const report = JSON.parse(verify.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(report.ok, true);
    assert.equal(report.providerSecretsVerified, 1);
    assert.ok(report.auditEventsVerified >= 3);
    assert.equal(report.counts.users, 1);
    assert.equal(report.counts.chats, 1);

    const wrongKeyEnv = { ...env, Z_AGENT_SECRET_KEY: '88'.repeat(32), Z_AGENT_SECRET_KEYS_JSON: '[]' };
    const wrongKey = run(['server/restore-verify.mjs', snapshot], wrongKeyEnv);
    assert.notEqual(wrongKey.status, 0, 'restore verification must fail when encrypted provider secrets cannot be decrypted');

    const manifestPath = `${snapshot}.manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
    manifest.createdAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const tamperedManifest = run(['server/restore-verify.mjs', snapshot], env);
    assert.notEqual(tamperedManifest.status, 0, 'restore verification must reject a tampered backup manifest');
    assert.match(tamperedManifest.stderr, /manifest HMAC/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
