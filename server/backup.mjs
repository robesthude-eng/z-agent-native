import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { signIntegrityPayload } from './native/audit.mjs';

const dbPath = path.resolve(process.env.Z_AGENT_DB_PATH || path.join(process.env.Z_AGENT_DATA_DIR || '/data', 'z-agent.sqlite'));
const target = path.resolve(process.argv[2] || path.join(path.dirname(dbPath), 'backups', `z-agent-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
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

let sourceStat;
try { sourceStat = fs.statSync(dbPath); } catch (error) {
  throw new Error(`Source database does not exist: ${dbPath}`, { cause: error });
}
if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error(`Source database is not a non-empty file: ${dbPath}`);
if (target === dbPath) throw new Error('Backup target must differ from source database');
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
if (fs.existsSync(target)) throw new Error(`Backup target already exists: ${target}`);
const db = new DatabaseSync(dbPath, { readOnly: false });
try {
  db.exec('PRAGMA busy_timeout=10000;');
  const sourceQuick = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
  if (sourceQuick !== 'ok') throw new Error(`Source database integrity check failed: ${sourceQuick}`);
  db.exec('PRAGMA wal_checkpoint(FULL);');
  // VACUUM INTO creates a transactionally consistent standalone database even
  // while the WAL-backed application remains online.
  const escaped = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}
fs.chmodSync(target, 0o600);
const stat = fs.statSync(target);
if (!stat.size) throw new Error('Backup file is empty');
const verify = new DatabaseSync(target, { readOnly: true });
let schemaVersion = 0;
try {
  const quick = String(verify.prepare('PRAGMA quick_check').get()?.quick_check || '');
  if (quick !== 'ok') throw new Error(`Backup integrity check failed: ${quick}`);
  schemaVersion = Number(verify.prepare('PRAGMA user_version').get()?.user_version || 0);
} finally { verify.close(); }
const manifestPath = `${target}.manifest.json`;
if (fs.existsSync(manifestPath)) throw new Error(`Backup manifest target already exists: ${manifestPath}`);
const payload = {
  version: 1,
  createdAt: new Date().toISOString(),
  snapshot: path.basename(target),
  bytes: stat.size,
  sha256: sha256File(target),
  schemaVersion,
};
const manifest = { ...payload, hmac: signIntegrityPayload('backup-manifest-v1', payload) };
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ok: true, path: target, manifest: manifestPath, bytes: stat.size, sha256: payload.sha256, schemaVersion }));
