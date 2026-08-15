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
  fs.writeFileSync(KEY_FILE, generated, { mode: 0o600, flag: 'wx' });
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
