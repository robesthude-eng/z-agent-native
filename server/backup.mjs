import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = path.resolve(process.env.Z_AGENT_DB_PATH || path.join(process.env.Z_AGENT_DATA_DIR || '/data', 'z-agent.sqlite'));
const target = path.resolve(process.argv[2] || path.join(path.dirname(dbPath), 'backups', `z-agent-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
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
try {
  const quick = String(verify.prepare('PRAGMA quick_check').get()?.quick_check || '');
  if (quick !== 'ok') throw new Error(`Backup integrity check failed: ${quick}`);
} finally { verify.close(); }
console.log(JSON.stringify({ ok: true, path: target, bytes: stat.size }));
