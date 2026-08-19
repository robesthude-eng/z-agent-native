import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, runMigrations } from './native/migrations.mjs';

const dbPath = path.resolve(process.env.Z_AGENT_DB_PATH || path.join(process.env.Z_AGENT_DATA_DIR || '/data', 'z-agent.sqlite'));
if (!fs.existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
  const result = runMigrations(db);
  const quick = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
  if (quick !== 'ok') throw new Error(`SQLite quick_check failed: ${quick}`);
  console.log(JSON.stringify({ ok: true, ...result, latest: LATEST_SCHEMA_VERSION, quickCheck: quick }));
} finally { db.close(); }
