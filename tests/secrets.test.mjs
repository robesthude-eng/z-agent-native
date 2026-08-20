import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-secrets-'));
process.env.Z_AGENT_DATA_DIR = root;
process.env.Z_AGENT_SECRET_KEY_STRICT = '1';
const oldKey = '11'.repeat(32);
const newKey = '22'.repeat(32);
process.env.Z_AGENT_SECRET_KEY = oldKey;
delete process.env.Z_AGENT_SECRET_KEYS_JSON;

const secrets = await import(`../server/native/secrets.mjs?secrets-test=${Date.now()}`);

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('v2 provider secrets authenticate their record context', () => {
  const context = 'provider:alice@example.test:openai:api_key';
  const encoded = secrets.encryptSecret('sk-top-secret', context);
  assert.match(encoded, /^enc:v2:[0-9a-f]{16}:/);
  assert.equal(secrets.decryptSecret(encoded, context), 'sk-top-secret');
  assert.throws(
    () => secrets.decryptSecret(encoded, 'provider:bob@example.test:openai:api_key'),
    /authentication failed/,
  );
});

test('keyring decrypts old v2 envelopes and rewraps them to the primary key', () => {
  const context = 'provider:alice@example.test:anthropic:api_key';
  process.env.Z_AGENT_SECRET_KEY = oldKey;
  delete process.env.Z_AGENT_SECRET_KEYS_JSON;
  secrets.resetSecretKeyCacheForTests();
  const oldEnvelope = secrets.encryptSecret('rotate-me', context);
  const oldKid = oldEnvelope.split(':')[2];

  process.env.Z_AGENT_SECRET_KEY = newKey;
  process.env.Z_AGENT_SECRET_KEYS_JSON = JSON.stringify([oldKey]);
  secrets.resetSecretKeyCacheForTests();
  assert.equal(secrets.decryptSecret(oldEnvelope, context), 'rotate-me');
  assert.equal(secrets.secretEnvelopeNeedsRewrap(oldEnvelope), true);
  const rotated = secrets.rewrapSecret(oldEnvelope, context);
  const newKid = rotated.split(':')[2];
  assert.notEqual(newKid, oldKid);
  assert.equal(secrets.decryptSecret(rotated, context), 'rotate-me');
  assert.equal(secrets.secretEnvelopeNeedsRewrap(rotated), false);

  process.env.Z_AGENT_SECRET_KEYS_JSON = '[]';
  secrets.resetSecretKeyCacheForTests();
  assert.equal(secrets.decryptSecret(rotated, context), 'rotate-me');
  assert.throws(() => secrets.decryptSecret(oldEnvelope, context), /not present in the configured keyring/);
});

test('strict production key parsing rejects passphrases and malformed keyring entries', () => {
  process.env.Z_AGENT_SECRET_KEY = 'human-readable-passphrase';
  process.env.Z_AGENT_SECRET_KEYS_JSON = '[]';
  process.env.Z_AGENT_SECRET_KEY_STRICT = '1';
  secrets.resetSecretKeyCacheForTests();
  assert.throws(() => secrets.encryptSecret('nope', 'ctx'), /64 hex characters or base64/);

  process.env.Z_AGENT_SECRET_KEY = newKey;
  process.env.Z_AGENT_SECRET_KEYS_JSON = JSON.stringify(['also-not-a-key']);
  secrets.resetSecretKeyCacheForTests();
  assert.throws(() => secrets.secretStoreReadinessCheck(), /64 hex characters or base64/);

  process.env.Z_AGENT_SECRET_KEY = newKey;
  process.env.Z_AGENT_SECRET_KEYS_JSON = '[]';
  secrets.resetSecretKeyCacheForTests();
  assert.equal(secrets.secretStoreReadinessCheck().ok, true);
});

test('production external-key policy rejects data-volume fallback and accepts a locked secret file', () => {
  delete process.env.Z_AGENT_SECRET_KEY;
  delete process.env.Z_AGENT_SECRET_KEY_FILE;
  process.env.Z_AGENT_SECRET_KEYS_JSON = '[]';
  process.env.Z_AGENT_REQUIRE_EXTERNAL_KEYS = '1';
  secrets.resetSecretKeyCacheForTests();
  assert.throws(() => secrets.secretStoreReadinessCheck(), /requires Z_AGENT_SECRET_KEY/);

  const secretFile = path.join(root, 'external-master.key');
  fs.writeFileSync(secretFile, Buffer.alloc(32, 0x33), { mode: 0o600 });
  process.env.Z_AGENT_SECRET_KEY_FILE = secretFile;
  secrets.resetSecretKeyCacheForTests();
  const ready = secrets.secretStoreReadinessCheck();
  assert.equal(ready.ok, true);
  assert.equal(ready.source, 'secret-file');

  fs.chmodSync(secretFile, 0o604);
  secrets.resetSecretKeyCacheForTests();
  assert.throws(() => secrets.secretStoreReadinessCheck(), /must not be accessible by other users/);

  fs.chmodSync(secretFile, 0o600);
  delete process.env.Z_AGENT_REQUIRE_EXTERNAL_KEYS;
});
