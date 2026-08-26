import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, WORKSPACES_DIR } from '../config.mjs';
import { inspectSchemaCompatibility, LATEST_SCHEMA_VERSION, runMigrations } from '../migrations.mjs';

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
    lifecycle TEXT NOT NULL,
    verdict TEXT,
    reason TEXT,
    since INTEGER NOT NULL,
    turn_id TEXT,
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    answers_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);

  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input_json TEXT NOT NULL,
    response TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_permissions_session ON permissions(session_id);

  CREATE TABLE IF NOT EXISTS prefs (
    owner_id TEXT PRIMARY KEY,
    theme TEXT NOT NULL DEFAULT 'dark',
    sidebar_collapsed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS provider_keys (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    key_ciphertext TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, provider_id),
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS provider_models_manual (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, provider_id, model_id),
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS provider_models_hidden (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, provider_id, model_id),
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS actions (
    session_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    result_json TEXT,
    error_text TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, action_id),
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS actions_queue (
    session_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, action_id),
    FOREIGN KEY(session_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS auth_failures (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    first_failed_at INTEGER NOT NULL,
    last_failed_at INTEGER NOT NULL,
    blocked_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_auth_failures_blocked ON auth_failures(blocked_until);

  CREATE TABLE IF NOT EXISTS turn_capacity (
    session_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    leased_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turn_capacity_owner ON turn_capacity(owner_id);
  CREATE INDEX IF NOT EXISTS idx_turn_capacity_expires ON turn_capacity(expires_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    timestamp INTEGER NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    target_json TEXT NOT NULL,
    details_json TEXT NOT NULL,
    signature TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category, timestamp DESC);
`);

inspectSchemaCompatibility(db);
runMigrations(db);

export function closeStore() {
  db.close();
}

export function storeReadinessCheck() {
  const result = db.prepare('SELECT 1 as alive').get();
  return { ok: result?.alive === 1 };
}
