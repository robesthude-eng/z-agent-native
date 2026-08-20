import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyAuditRows } from './native/audit.mjs';

const dbPath = path.resolve(process.argv[2] || process.env.Z_AGENT_DB_PATH || path.join(process.env.Z_AGENT_DATA_DIR || '/data', 'z-agent.sqlite'));
if (!fs.existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='audit_events'").get();
  if (!table?.ok) throw new Error('audit_events table is missing; migrate the database first');
  const rows = db.prepare('SELECT seq,event_id,ts,actor_hash,action,target_hash,detail_json,prev_hash,event_hash FROM audit_events ORDER BY seq').all();
  const result = verifyAuditRows(rows);
  if (!result.ok) {
    console.error(JSON.stringify(result));
    process.exitCode = 2;
  } else console.log(JSON.stringify(result));
} finally { db.close(); }
