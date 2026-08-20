import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const KEY_FILE = path.join(DATA_DIR, 'master.key');
let cachedKey = null;

function parseConfiguredKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
  } catch {}
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function masterKey() {
  if (cachedKey) return cachedKey;
  const configured = parseConfiguredKey(process.env.Z_AGENT_SECRET_KEY);
  if (configured) return (cachedKey = configured);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const existing = fs.readFileSync(KEY_FILE);
    if (existing.length === 32) return (cachedKey = existing);
  } catch {}
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_FILE, generated, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Two processes booting at once both miss the read above and both race to
    // create the key. `wx` is what keeps the loser from overwriting the winner
    // (which would make every already-encrypted provider key undecryptable),
    // but the resulting EEXIST used to escape as a startup crash. Adopt the key
    // that actually landed on disk instead.
    if (error?.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(KEY_FILE);
    if (existing.length !== 32) throw error;
    try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
    return (cachedKey = existing);
  }
  try { fs.chmodSync(KEY_FILE, 0o600); } catch {}
  return (cachedKey = generated);
}

export function encryptSecret(value) {
  const plain = String(value ?? '');
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value) {
  const encoded = String(value ?? '');
  if (!encoded.startsWith('enc:v1:')) return encoded; // legacy plaintext is migrated on next save
  const [, version, ivText, tagText, cipherText] = encoded.split(':');
  if (version !== 'v1' || !ivText || !tagText || cipherText == null) throw new Error('Unsupported encrypted secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
}

export function secretStoreReadinessCheck() {
  const key = masterKey();
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Master key is unavailable');
  const configured = Boolean(parseConfiguredKey(process.env.Z_AGENT_SECRET_KEY));
  if (!configured) {
    const stat = fs.statSync(KEY_FILE);
    if ((stat.mode & 0o077) !== 0) throw new Error('master.key permissions are too broad');
  }
  return { ok: true, source: configured ? 'env' : 'file' };
}
