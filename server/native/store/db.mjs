import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, WORKSPACES_DIR } from '../config.mjs';
import { LATEST_SCHEMA_VERSION, inspectSchemaCompatibility, runMigrations } from '../migrations.mjs';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
try { fs.chmodSync(WORKSPACES_DIR, typeof process.getuid === 'function' && process.getuid() === 0 ? 0o711 : 0o700); } catch {}

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(email) REFERENCES users(email) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_email ON auth_sessions(email);

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sandbox_uid INTEGER,
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chats_owner_updated ON chats(owner_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    parts_json TEXT NOT NULL,
    info_json TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    verdict TEXT,
    reason TEXT,
    since INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    answers_json TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_questions_session_status ON questions(session_id, status);

  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input_json TEXT,
    response TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_permissions_session_status ON permissions(session_id, status);

  CREATE TABLE IF NOT EXISTS actions (
    session_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    state TEXT NOT NULL,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, action_id),
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS action_queue (
    session_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, action_id),
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_prefs (
    owner_id TEXT PRIMARY KEY,
    prefs_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS provider_keys (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    api_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, provider_id),
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS provider_models (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT,
    base_url TEXT,
    is_free INTEGER NOT NULL DEFAULT 0,
    pattern INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, provider_id, model_id)
  );

  CREATE TABLE IF NOT EXISTS hidden_models (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, provider_id, model_id)
  );

  CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

inspectSchemaCompatibility(db);
runMigrations(db);

export function closeStore() {
  db.close();
}

export function storeReadinessCheck() {
  const now = Date.now();
  const row = db.prepare('SELECT 1 AS ok').get();
  if (row?.ok !== 1) throw new Error('SQLite read probe failed');
  db.exec('SAVEPOINT readiness_probe');
  try {
    db.prepare("INSERT INTO runtime_meta(key,value) VALUES('readiness_probe',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
    db.exec('ROLLBACK TO readiness_probe; RELEASE readiness_probe');
  } catch (error) {
    try { db.exec('ROLLBACK TO readiness_probe; RELEASE readiness_probe'); } catch {}
    throw error;
  }
  const schema = inspectSchemaCompatibility(db);
  if (!schema.compatible) throw new Error(`SQLite schema ${schema.currentVersion} is not compatible with code schema ${LATEST_SCHEMA_VERSION}`);
  return {
    ok: true,
    journalMode: String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || ''),
    schemaVersion: schema.currentVersion,
    expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    newerCompatible: schema.newerCompatible,
    at: now,
  };
}
