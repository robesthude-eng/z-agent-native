import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-migrate-data-'));
const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-migrate-workspaces-'));
const dbPath = path.join(data, 'z-agent.sqlite');
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
  CREATE TABLE users (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE provider_keys (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, provider_id)
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );
`);
legacy.prepare('INSERT INTO users(email,password_hash,role,created_at) VALUES(?,?,?,?)').run('legacy@example.com', 'hash', 'admin', 1);
legacy.prepare('INSERT INTO provider_keys(owner_id,provider_id,api_key,updated_at) VALUES(?,?,?,?)').run('legacy@example.com', 'openai', 'legacy-plaintext-key', 1);
legacy.prepare('INSERT INTO chats(id,owner_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run('ses_legacy1', 'legacy@example.com', 'Legacy', 1, 1);
legacy.close();

process.env.Z_AGENT_DATA_DIR = data;
process.env.Z_AGENT_WORKSPACES_DIR = workspaces;
const store = await import('../server/native/store.mjs');

test('legacy chats schema migrates to persistent sandbox identities without losing chats', () => {
  const legacyUid = store.getSandboxUid('ses_legacy1');
  assert.ok(Number.isInteger(legacyUid));
  assert.equal(store.getChat('ses_legacy1', 'legacy@example.com')?.title, 'Legacy');
  store.createChat('ses_aftermigration1', 'legacy@example.com', 'After');
  assert.ok(store.getSandboxUid('ses_aftermigration1') > legacyUid);
  assert.equal(store.getProviderKey('legacy@example.com', 'openai'), 'legacy-plaintext-key');
});

test.after(() => {
  store.closeStore();
  const verify = new DatabaseSync(dbPath);
  const encrypted = verify.prepare("SELECT api_key FROM provider_keys WHERE owner_id='legacy@example.com' AND provider_id='openai'").get().api_key;
  assert.match(encrypted, /^enc:v1:/);
  verify.close();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(workspaces, { recursive: true, force: true });
});
