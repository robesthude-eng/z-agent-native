import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-audit-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_SECRET_KEY = '44'.repeat(32);
process.env.Z_AGENT_SECRET_KEY_STRICT = '1';
process.env.Z_AGENT_AUDIT_KEY = '55'.repeat(32);
const store = await import(`../server/native/store.mjs?audit-test=${Date.now()}`);

test.after(() => {
  try { store.closeStore(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

test('security-sensitive mutations append a pseudonymised HMAC chain', () => {
  const email = 'owner@example.test';
  const passwordHash = 'scrypt$test-only';
  assert.equal(store.createRegistrationUser(email, passwordHash, { allowAdditional: true }).status, 'created');
  store.createAuthSession('bearer-secret-token', email, 'csrf-secret');
  store.setProviderKey(email, 'openai', 'sk-should-never-be-audited');
  const chat = store.createChat('ses_Audit123', email, 'audit test');
  assert.equal(chat.id, 'ses_Audit123');
  assert.equal(store.deleteChat(chat.id, email), true);
  store.deleteAuthSession('bearer-secret-token');

  const verified = store.verifyAuditLog();
  assert.equal(verified.ok, true);
  assert.ok(verified.events >= 6);

  const db = new DatabaseSync(path.join(process.env.Z_AGENT_DATA_DIR, 'z-agent.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT actor_hash,target_hash,detail_json,action FROM audit_events ORDER BY seq').all();
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, /owner@example\.test/i);
    assert.doesNotMatch(serialized, /sk-should-never-be-audited/);
    assert.doesNotMatch(serialized, /bearer-secret-token/);
    assert.ok(rows.some((row) => row.action === 'provider.secret_set'));
  } finally { db.close(); }
});

test('audit verification detects database-only history tampering', () => {
  assert.equal(store.verifyAuditLog().ok, true);
  const db = new DatabaseSync(path.join(process.env.Z_AGENT_DATA_DIR, 'z-agent.sqlite'));
  try {
    db.prepare("UPDATE audit_events SET action='provider.secret_delete' WHERE seq=(SELECT MIN(seq) FROM audit_events)").run();
  } finally { db.close(); }
  const result = store.verifyAuditLog();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});
