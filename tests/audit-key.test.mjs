import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-audit-key-'));
process.env.Z_AGENT_DATA_DIR = root;
delete process.env.Z_AGENT_AUDIT_KEY;
delete process.env.Z_AGENT_AUDIT_KEY_FILE;
process.env.Z_AGENT_REQUIRE_EXTERNAL_KEYS = '1';
const audit = await import(`../server/native/audit.mjs?audit-key-test=${Date.now()}`);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('production audit policy requires an external HMAC key', () => {
  audit.resetAuditKeyCacheForTests();
  assert.throws(() => audit.auditKeyReadinessCheck(), /requires Z_AGENT_AUDIT_KEY/);
});

test('locked audit secret files are accepted and world-readable ones are rejected', () => {
  const file = path.join(root, 'audit-external.key');
  fs.writeFileSync(file, Buffer.alloc(32, 0x71), { mode: 0o600 });
  process.env.Z_AGENT_AUDIT_KEY_FILE = file;
  audit.resetAuditKeyCacheForTests();
  assert.deepEqual(audit.auditKeyReadinessCheck(), { ok: true, source: 'secret-file' });

  fs.chmodSync(file, 0o604);
  audit.resetAuditKeyCacheForTests();
  assert.throws(() => audit.auditKeyReadinessCheck(), /must not be accessible by other users/);
});
