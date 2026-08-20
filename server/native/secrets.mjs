import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const KEY_FILE = path.join(DATA_DIR, 'master.key');
let cachedRing = null;

function parseKeyMaterial(value, { strict = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32 && b64.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) return b64;
  } catch {}
  if (strict) throw new Error('Configured secret keys must be 64 hex characters or base64 encoding exactly 32 bytes');
  // Legacy self-hosted compatibility only. Production Compose enables strict
  // parsing so a typo/passphrase cannot silently become a different key.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}


function readConfiguredKeyFile(filePath, { strict = false } = {}) {
  const configured = String(filePath || '').trim();
  if (!configured) return null;
  const stat = fs.statSync(configured);
  if (!stat.isFile()) throw new Error('Z_AGENT_SECRET_KEY_FILE must point to a regular file');
  if ((stat.mode & 0o007) !== 0) throw new Error('Z_AGENT_SECRET_KEY_FILE must not be accessible by other users');
  const raw = fs.readFileSync(configured);
  if (raw.length === 32) return raw;
  return parseKeyMaterial(raw.toString('utf8'), { strict });
}

function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function readKeyFile() {
  try {
    const existing = fs.readFileSync(KEY_FILE);
    if (existing.length === 32) return existing;
  } catch {}
  return null;
}

function createKeyFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, generated, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
    return generated;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readKeyFile();
    if (!existing) throw error;
    try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
    return existing;
  }
}

function configuredExtras(strict) {
  const raw = String(process.env.Z_AGENT_SECRET_KEYS_JSON || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Z_AGENT_SECRET_KEYS_JSON must be a JSON array'); }
  if (!Array.isArray(parsed) || parsed.length > 8) throw new Error('Z_AGENT_SECRET_KEYS_JSON must contain at most 8 keys');
  return parsed.map((value) => parseKeyMaterial(value, { strict })).filter(Boolean);
}

function keyRing() {
  if (cachedRing) return cachedRing;
  const strict = process.env.Z_AGENT_SECRET_KEY_STRICT === '1';
  const envPrimary = parseKeyMaterial(process.env.Z_AGENT_SECRET_KEY, { strict });
  const filePrimary = readConfiguredKeyFile(process.env.Z_AGENT_SECRET_KEY_FILE, { strict });
  if (envPrimary && filePrimary) throw new Error('Configure only one of Z_AGENT_SECRET_KEY or Z_AGENT_SECRET_KEY_FILE');
  const configuredPrimary = envPrimary || filePrimary;
  const extras = configuredExtras(strict);
  const fileKey = readKeyFile();
  const keys = [];
  if (configuredPrimary) keys.push(configuredPrimary, ...extras);
  else keys.push(fileKey || createKeyFile(), ...extras);

  const seen = new Set();
  const entries = [];
  for (const key of keys) {
    const id = keyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, key });
  }
  if (!entries.length) throw new Error('No encryption key is available');
  cachedRing = { entries, primary: entries[0], configured: Boolean(configuredPrimary), strict, source: envPrimary ? 'env-keyring' : filePrimary ? 'secret-file' : 'data-file' };
  return cachedRing;
}

function aadFor(context = '') {
  return Buffer.from(`z-agent-secret:v2:${String(context || '')}`, 'utf8');
}

function decryptV1(parts) {
  const [, version, ivText, tagText, cipherText] = parts;
  if (version !== 'v1' || !ivText || !tagText || cipherText == null) throw new Error('Unsupported encrypted secret format');
  let lastError = null;
  for (const entry of keyRing().entries) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', entry.key, Buffer.from(ivText, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
    } catch (error) { lastError = error; }
  }
  throw new Error('Encrypted secret cannot be decrypted by the configured keyring', { cause: lastError });
}

export function encryptSecret(value, context = '') {
  const plain = String(value ?? '');
  if (!plain) return '';
  const { primary } = keyRing();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', primary.key, iv);
  cipher.setAAD(aadFor(context));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v2:${primary.id}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value, context = '') {
  const encoded = String(value ?? '');
  if (!encoded.startsWith('enc:')) return encoded; // legacy plaintext is migrated by store startup
  const parts = encoded.split(':');
  if (parts[1] === 'v1') return decryptV1(parts);
  if (parts[1] !== 'v2' || parts.length !== 6) throw new Error('Unsupported encrypted secret format');
  const [, , id, ivText, tagText, cipherText] = parts;
  const entry = keyRing().entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Secret key ${id} is not present in the configured keyring`);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', entry.key, Buffer.from(ivText, 'base64url'));
    decipher.setAAD(aadFor(context));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error('Encrypted secret authentication failed (wrong key or record context)', { cause: error });
  }
}

export function secretEnvelopeNeedsRewrap(value) {
  const encoded = String(value || '');
  if (!encoded.startsWith('enc:v2:')) return Boolean(encoded);
  const id = encoded.split(':')[2] || '';
  return id !== keyRing().primary.id;
}

export function rewrapSecret(value, context = '') {
  const encoded = String(value || '');
  if (!encoded) return '';
  if (!secretEnvelopeNeedsRewrap(encoded)) {
    // Authenticate the envelope/context even if the key id is already current.
    decryptSecret(encoded, context);
    return encoded;
  }
  return encryptSecret(decryptSecret(encoded, context), context);
}

export function secretStoreReadinessCheck() {
  const ring = keyRing();
  if (process.env.Z_AGENT_REQUIRE_EXTERNAL_KEYS === '1' && !ring.configured) {
    throw new Error('Production requires Z_AGENT_SECRET_KEY or Z_AGENT_SECRET_KEY_FILE outside the data volume');
  }
  if (ring.entries.some((entry) => !Buffer.isBuffer(entry.key) || entry.key.length !== 32)) throw new Error('Master key is unavailable');
  if (!ring.configured) {
    const stat = fs.statSync(KEY_FILE);
    if ((stat.mode & 0o077) !== 0) throw new Error('master.key permissions are too broad');
  }
  return { ok: true, source: ring.source, activeKeyId: ring.primary.id, keyCount: ring.entries.length, strict: ring.strict };
}

export function resetSecretKeyCacheForTests() { cachedRing = null; }
