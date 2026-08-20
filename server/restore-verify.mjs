import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptSecret } from './native/secrets.mjs';
import { verifyAuditRows, verifyIntegrityPayload } from './native/audit.mjs';
import { LATEST_SCHEMA_VERSION } from './native/migrations.mjs';

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

const snapshot = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node server/restore-verify.mjs <snapshot.sqlite>');
const stat = fs.statSync(snapshot);
if (!stat.isFile() || stat.size <= 0) throw new Error(`Snapshot is not a non-empty file: ${snapshot}`);
const manifestPath = `${snapshot}.manifest.json`;
let manifestVerified = false;
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { hmac, ...payload } = manifest;
  if (Number(payload.version) !== 1) throw new Error(`Unsupported backup manifest version: ${payload.version}`);
  if (String(payload.snapshot) !== path.basename(snapshot)) throw new Error('Backup manifest snapshot name mismatch');
  if (Number(payload.bytes) !== stat.size) throw new Error('Backup manifest size mismatch');
  if (!/^[0-9a-f]{64}$/i.test(String(payload.sha256 || '')) || sha256File(snapshot) !== String(payload.sha256).toLowerCase()) {
    throw new Error('Backup manifest SHA-256 mismatch');
  }
  if (!verifyIntegrityPayload('backup-manifest-v1', payload, hmac)) throw new Error('Backup manifest HMAC verification failed');
  manifestVerified = true;
} else if (process.env.Z_AGENT_RESTORE_REQUIRE_MANIFEST === '1') {
  throw new Error(`Backup manifest is required but missing: ${manifestPath}`);
}

const db = new DatabaseSync(snapshot, { readOnly: true });
try {
  const quick = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
  if (quick !== 'ok') throw new Error(`SQLite quick_check failed: ${quick}`);
  const foreign = db.prepare('PRAGMA foreign_key_check').all();
  if (foreign.length) throw new Error(`SQLite foreign_key_check reported ${foreign.length} violation(s)`);
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  const marker = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='schema_compatibility'").get()
    ? db.prepare('SELECT current_version,min_reader_version FROM schema_compatibility WHERE singleton=1').get()
    : null;
  const schemaCompatible = schemaVersion === LATEST_SCHEMA_VERSION
    || (schemaVersion > LATEST_SCHEMA_VERSION && Number(marker?.current_version) === schemaVersion && Number(marker?.min_reader_version) <= LATEST_SCHEMA_VERSION);
  if (!schemaCompatible) throw new Error(`Snapshot schema ${schemaVersion} is not compatible with code schema ${LATEST_SCHEMA_VERSION}`);

  const requiredTables = ['users','auth_sessions','chats','messages','provider_keys','schema_migrations','audit_events','turn_capacity_leases'];
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
  const missing = requiredTables.filter((name) => !existing.has(name));
  if (missing.length) throw new Error(`Snapshot is missing required tables: ${missing.join(', ')}`);

  let providerSecrets = 0;
  for (const row of db.prepare("SELECT owner_id,provider_id,api_key FROM provider_keys WHERE api_key<>''").all()) {
    decryptSecret(row.api_key, `provider:${row.owner_id}:${row.provider_id}:api_key`);
    providerSecrets += 1;
  }

  const auditRows = db.prepare('SELECT seq,event_id,ts,actor_hash,action,target_hash,detail_json,prev_hash,event_hash FROM audit_events ORDER BY seq').all();
  const audit = verifyAuditRows(auditRows);
  if (!audit.ok) throw new Error(`Audit chain verification failed at seq ${audit.seq}: ${audit.reason}`);

  const counts = {};
  for (const table of ['users','auth_sessions','chats','messages','provider_keys','audit_events']) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0);
  }
  console.log(JSON.stringify({
    ok: true, snapshot, bytes: stat.size, manifestVerified, quickCheck: quick, foreignKeyViolations: 0,
    schemaVersion, codeSchemaVersion: LATEST_SCHEMA_VERSION, providerSecretsVerified: providerSecrets,
    auditEventsVerified: audit.events, auditHead: audit.head, counts,
  }));
} finally { db.close(); }
