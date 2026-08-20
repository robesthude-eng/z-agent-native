import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const AUDIT_KEY_FILE = path.join(DATA_DIR, 'audit.key');
let cachedKey = null;

function parseKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) return decoded;
  } catch {}
  throw new Error('Z_AGENT_AUDIT_KEY must be 64 hex characters or base64 encoding exactly 32 bytes');
}


function configuredAuditKey() {
  const envKey = parseKey(process.env.Z_AGENT_AUDIT_KEY);
  const filePath = String(process.env.Z_AGENT_AUDIT_KEY_FILE || '').trim();
  if (envKey && filePath) throw new Error('Configure only one of Z_AGENT_AUDIT_KEY or Z_AGENT_AUDIT_KEY_FILE');
  if (envKey) return { key: envKey, source: 'env' };
  if (!filePath) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Z_AGENT_AUDIT_KEY_FILE must point to a regular file');
  if ((stat.mode & 0o007) !== 0) throw new Error('Z_AGENT_AUDIT_KEY_FILE must not be accessible by other users');
  const raw = fs.readFileSync(filePath);
  const key = raw.length === 32 ? raw : parseKey(raw.toString('utf8'));
  return { key, source: 'secret-file' };
}

function auditKey() {
  if (cachedKey) return cachedKey;
  const configured = configuredAuditKey();
  if (configured) return (cachedKey = configured.key);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(AUDIT_KEY_FILE);
    if (existing.length !== 32) throw new Error('audit.key must contain exactly 32 bytes');
    try { fs.chmodSync(AUDIT_KEY_FILE, 0o600); } catch {}
    return (cachedKey = existing);
  } catch (error) {
    if (error?.code && error.code !== 'ENOENT') throw error;
  }
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(AUDIT_KEY_FILE, generated, { flag: 'wx', mode: 0o600 });
    return (cachedKey = generated);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(AUDIT_KEY_FILE);
    if (existing.length !== 32) throw new Error('audit.key must contain exactly 32 bytes');
    return (cachedKey = existing);
  }
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}

function hmac(label, value) {
  return crypto.createHmac('sha256', auditKey()).update(`${label}\0${String(value ?? '')}`, 'utf8').digest('hex');
}

export function auditIdentity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized ? `hmac256:${hmac('identity', normalized)}` : '';
}

export function auditTarget(value) {
  const normalized = String(value || '').trim();
  return normalized ? `hmac256:${hmac('target', normalized)}` : '';
}

export function canonicalAuditPayload(event) {
  return stable({
    eventId: String(event.event_id || event.eventId || ''),
    ts: Number(event.ts),
    actorHash: String(event.actor_hash || event.actorHash || ''),
    action: String(event.action || ''),
    targetHash: String(event.target_hash || event.targetHash || ''),
    detailJson: String(event.detail_json || event.detailJson || '{}'),
    prevHash: String(event.prev_hash || event.prevHash || ''),
  });
}

export function signAuditEvent(event) {
  return `hmac256:${crypto.createHmac('sha256', auditKey()).update(canonicalAuditPayload(event), 'utf8').digest('hex')}`;
}

export function verifyAuditRows(rows) {
  let prev = '';
  for (const row of rows) {
    if (String(row.prev_hash || '') !== prev) return { ok: false, seq: Number(row.seq), reason: 'chain_mismatch' };
    const expected = signAuditEvent(row);
    const left = Buffer.from(String(row.event_hash || ''));
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return { ok: false, seq: Number(row.seq), reason: 'signature_mismatch' };
    prev = String(row.event_hash || '');
  }
  return { ok: true, events: rows.length, head: prev };
}



export function signIntegrityPayload(label, payload) {
  const body = typeof payload === 'string' ? payload : stable(payload);
  return `hmac256:${crypto.createHmac('sha256', auditKey()).update(`integrity\0${String(label || '')}\0${body}`, 'utf8').digest('hex')}`;
}

export function verifyIntegrityPayload(label, payload, signature) {
  const expected = signIntegrityPayload(label, payload);
  const left = Buffer.from(String(signature || ''));
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

export function auditKeyReadinessCheck() {
  const configured = configuredAuditKey();
  const key = auditKey();
  if (process.env.Z_AGENT_REQUIRE_EXTERNAL_KEYS === '1' && !configured) {
    throw new Error('Production requires Z_AGENT_AUDIT_KEY or Z_AGENT_AUDIT_KEY_FILE outside the data volume');
  }
  if (key.length !== 32) throw new Error('Audit key unavailable');
  if (!configured) {
    const stat = fs.statSync(AUDIT_KEY_FILE);
    if ((stat.mode & 0o077) !== 0) throw new Error('audit.key permissions are too broad');
  }
  return { ok: true, source: configured?.source || 'data-file' };
}

export function resetAuditKeyCacheForTests() { cachedKey = null; }
