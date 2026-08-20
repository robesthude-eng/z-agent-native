import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH, WORKSPACES_DIR } from './config.mjs';
import { decryptSecret, encryptSecret, rewrapSecret } from './secrets.mjs';
import { LATEST_SCHEMA_VERSION, inspectSchemaCompatibility, runMigrations } from './migrations.mjs';
import { auditIdentity, auditTarget, signAuditEvent, verifyAuditRows } from './audit.mjs';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
try { fs.chmodSync(WORKSPACES_DIR, typeof process.getuid === 'function' && process.getuid() === 0 ? 0o711 : 0o700); } catch {}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  -- Three modules open their own DatabaseSync handle on this same file
  -- (store, provider-configs, cluster). Without a busy timeout the loser of a
  -- write race gets an immediate SQLITE_BUSY instead of waiting for the current
  -- writer, which surfaced as random "database is locked" 500s under load.
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

// Apply explicit, versioned forward-only migrations before data backfills.
runMigrations(db);

function bootstrapSandboxUids() {
  let next = Number(db.prepare('SELECT MAX(sandbox_uid) max_uid FROM chats').get()?.max_uid || 19999) + 1;
  next = Math.max(20000, next);
  for (const row of db.prepare('SELECT id FROM chats WHERE sandbox_uid IS NULL ORDER BY created_at,id').all()) {
    db.prepare('UPDATE chats SET sandbox_uid=? WHERE id=?').run(next, row.id);
    next += 1;
  }
  const current = Number(db.prepare("SELECT value FROM runtime_meta WHERE key='sandbox_uid_next'").get()?.value || 0);
  const floor = Number(db.prepare('SELECT MAX(sandbox_uid) max_uid FROM chats').get()?.max_uid || 19999) + 1;
  const wanted = Math.max(20000, floor, current);
  db.prepare("INSERT INTO runtime_meta(key,value) VALUES('sandbox_uid_next',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(wanted));
}

bootstrapSandboxUids();

function authSessionKey(token) {
  const value = String(token || '');
  if (!value) return '';
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

// Browser cookies keep the random bearer token, but the database stores only a
// one-way digest. A database snapshot leak therefore does not hand an attacker
// immediately reusable authenticated cookies. Legacy plaintext rows can be
// migrated in place because they contain the original bearer value.
for (const row of db.prepare("SELECT token FROM auth_sessions WHERE token NOT LIKE 'sha256:%'").all()) {
  db.prepare('UPDATE auth_sessions SET token=? WHERE token=?').run(authSessionKey(row.token), row.token);
}

// Transparent provider-secret migration/rotation. v2 envelopes bind the
// ciphertext to its owner/provider record through AES-GCM AAD. Supplying a new
// primary key plus the previous key in Z_AGENT_SECRET_KEYS_JSON rewraps every
// row at startup; the old key can be removed after readiness succeeds.
for (const row of db.prepare("SELECT owner_id,provider_id,api_key FROM provider_keys WHERE api_key <> ''").all()) {
  const context = `provider:${row.owner_id}:${row.provider_id}:api_key`;
  const next = rewrapSecret(row.api_key, context); // also authenticates AAD/current envelope
  if (next !== row.api_key) {
    db.prepare('UPDATE provider_keys SET api_key=?,updated_at=? WHERE owner_id=? AND provider_id=?')
      .run(next, Date.now(), row.owner_id, row.provider_id);
  }
}

function allocateSandboxUid() {
  // The Unix uid IS the sandbox boundary, so allocation must be atomic: a
  // SELECT followed by a separate UPDATE let two concurrent chat creations hand
  // the same identity (and therefore the same filesystem access) to two chats.
  db.prepare("INSERT OR IGNORE INTO runtime_meta(key,value) VALUES('sandbox_uid_next','20000')").run();
  const row = db.prepare("UPDATE runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='sandbox_uid_next' RETURNING value").get();
  const uid = Number(row?.value) - 1;
  if (!Number.isInteger(uid) || uid < 20000 || uid > 2_000_000_000) throw new Error('Sandbox Unix identity space exhausted');
  return uid;
}

const parse = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

export function workspaceFor(sessionId) {
  const root = path.join(WORKSPACES_DIR, sessionId);
  fs.mkdirSync(root, { recursive: true });
  try { fs.chmodSync(root, 0o700); } catch {}
  return root;
}

export function createUser(email, passwordHash, role = 'user') {
  db.prepare('INSERT INTO users(email,password_hash,role,created_at) VALUES(?,?,?,?)')
    .run(email, passwordHash, role, Date.now());
}
export function createRegistrationUser(email, passwordHash, { allowAdditional = false } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      db.exec('ROLLBACK');
      return { status: 'exists', role: null };
    }
    const bootstrap = Number(db.prepare('SELECT COUNT(*) AS c FROM users').get()?.c || 0) === 0;
    if (!bootstrap && !allowAdditional) {
      db.exec('ROLLBACK');
      return { status: 'closed', role: null };
    }
    const role = bootstrap ? 'admin' : 'user';
    db.prepare('INSERT INTO users(email,password_hash,role,created_at) VALUES(?,?,?,?)').run(email, passwordHash, role, Date.now());
    insertAuditEventInCurrentTransaction({ actor: email, action: 'auth.register', target: email, details: { role, bootstrap } });
    db.exec('COMMIT');
    return { status: 'created', role };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
export function getUser(email) {
  return db.prepare('SELECT email,password_hash,role,created_at FROM users WHERE email=?').get(email) || null;
}
export function userCount() { return db.prepare('SELECT COUNT(*) c FROM users').get().c; }
export function updatePassword(email, passwordHash) {
  db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(passwordHash, email);
}
export function updatePasswordAndRevokeSessions(email, passwordHash, keepToken) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(passwordHash, email);
    const revoked = db.prepare('DELETE FROM auth_sessions WHERE email=? AND token<>?').run(email, authSessionKey(keepToken)).changes;
    insertAuditEventInCurrentTransaction({ actor: email, action: 'auth.password_change', target: email, details: { revokedSessions: Number(revoked) } });
    db.exec('COMMIT');
    return Number(revoked);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
export function createAuthSession(token, email, csrf = null) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO auth_sessions(token,email,created_at,csrf) VALUES(?,?,?,?)').run(authSessionKey(token), email, Date.now(), csrf || null);
    insertAuditEventInCurrentTransaction({ actor: email, action: 'auth.session_issued', target: email });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
export function getAuthSession(token) {
  return db.prepare('SELECT token,email,created_at,csrf FROM auth_sessions WHERE token=?').get(authSessionKey(token)) || null;
}
export function deleteAuthSession(token) {
  const key = authSessionKey(token);
  db.exec('BEGIN IMMEDIATE');
  try {
    const email = String(db.prepare('SELECT email FROM auth_sessions WHERE token=?').get(key)?.email || '');
    const changes = db.prepare('DELETE FROM auth_sessions WHERE token=?').run(key).changes;
    if (changes && email) insertAuditEventInCurrentTransaction({ actor: email, action: 'auth.logout', target: email });
    db.exec('COMMIT');
    return Boolean(changes);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
export function deleteOtherAuthSessions(email, keepToken) {
  return db.prepare('DELETE FROM auth_sessions WHERE email=? AND token<>?').run(email, authSessionKey(keepToken)).changes;
}
export function pruneAuthSessions(before) { db.prepare('DELETE FROM auth_sessions WHERE created_at < ?').run(before); }

export function authRateLimitExceeded(buckets, limits, now = Date.now()) {
  const unique = [...new Set((buckets || []).map(String).filter(Boolean))];
  for (const bucket of unique) {
    const row = db.prepare('SELECT failures,reset_at FROM auth_rate_limits WHERE bucket=?').get(bucket);
    if (!row || Number(row.reset_at) <= now) continue;
    const max = Number(limits?.[bucket] ?? limits?.default ?? 20);
    if (Number(row.failures) >= max) return true;
  }
  return false;
}

export function recordAuthFailures(buckets, { windowMs = 10 * 60 * 1000 } = {}, now = Date.now()) {
  const unique = [...new Set((buckets || []).map(String).filter(Boolean))];
  if (!unique.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const select = db.prepare('SELECT failures,reset_at FROM auth_rate_limits WHERE bucket=?');
    const upsert = db.prepare(`
      INSERT INTO auth_rate_limits(bucket,failures,reset_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(bucket) DO UPDATE SET failures=excluded.failures,reset_at=excluded.reset_at,updated_at=excluded.updated_at
    `);
    for (const bucket of unique) {
      const row = select.get(bucket);
      const active = row && Number(row.reset_at) > now;
      upsert.run(bucket, active ? Number(row.failures) + 1 : 1, active ? Number(row.reset_at) : now + windowMs, now);
    }
    db.prepare('DELETE FROM auth_rate_limits WHERE reset_at < ?').run(now - windowMs);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function chatRow(row) {
  return row ? { id: row.id, title: row.title, time: { created: row.created_at, updated: row.updated_at }, version: 'native-1' } : null;
}
export function createChat(id, ownerId, title = 'Новый чат') {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO chats(id,owner_id,title,created_at,updated_at,sandbox_uid) VALUES(?,?,?,?,?,?)').run(id, ownerId, title, now, now, allocateSandboxUid());
    insertAuditEventInCurrentTransaction({ actor: ownerId, action: 'chat.create', target: id });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  workspaceFor(id);
  return chatRow(db.prepare('SELECT * FROM chats WHERE id=?').get(id));
}
export function listChats(ownerId) {
  return db.prepare('SELECT * FROM chats WHERE owner_id=? ORDER BY updated_at DESC').all(ownerId).map(chatRow);
}
export function getChat(id, ownerId) {
  return chatRow(db.prepare('SELECT * FROM chats WHERE id=? AND owner_id=?').get(id, ownerId));
}
export function ownsChat(id, ownerId) {
  return Boolean(db.prepare('SELECT 1 FROM chats WHERE id=? AND owner_id=?').get(id, ownerId));
}
export function getSandboxUid(id) {
  const value = db.prepare('SELECT sandbox_uid FROM chats WHERE id=?').get(id)?.sandbox_uid;
  return Number.isInteger(Number(value)) ? Number(value) : null;
}
export function renameChat(id, ownerId, title) {
  db.prepare('UPDATE chats SET title=?,updated_at=? WHERE id=? AND owner_id=?').run(title, Date.now(), id, ownerId);
  return getChat(id, ownerId);
}
export function touchChat(id) { db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(Date.now(), id); }
export function deleteChat(id, ownerId) {
  db.exec('BEGIN IMMEDIATE');
  let deleted = false;
  try {
    const result = db.prepare('DELETE FROM chats WHERE id=? AND owner_id=?').run(id, ownerId);
    deleted = Boolean(result.changes);
    if (deleted) insertAuditEventInCurrentTransaction({ actor: ownerId, action: 'chat.delete', target: id });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  if (deleted) fs.rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true });
  return deleted;
}

function messageRow(row) {
  if (!row) return null;
  const info = parse(row.info_json, {}) || {};
  info.id ??= row.id;
  info.role ??= row.role;
  info.time ??= { created: row.created_at, ...(row.completed_at ? { completed: row.completed_at } : {}) };
  return {
    id: row.id,
    role: row.role,
    sessionID: row.session_id,
    parts: parse(row.parts_json, []),
    time: { created: row.created_at, ...(row.completed_at ? { completed: row.completed_at } : {}) },
    info,
  };
}
export function putMessage(message) {
  // created_at drives both list ordering and the "delete from this message"
  // pivot, so a timestamp from the future would pin a message to the end of
  // history forever. Clamp it to server time.
  const created = Math.min(Number(message.time?.created) || Date.now(), Date.now());
  const completed = message.time?.completed || message.info?.time?.completed || null;
  db.prepare(`INSERT INTO messages(id,session_id,role,parts_json,info_json,created_at,completed_at)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET parts_json=excluded.parts_json,info_json=excluded.info_json,completed_at=excluded.completed_at`)
    .run(message.id, message.sessionID, message.role, JSON.stringify(message.parts || []), JSON.stringify(message.info || {}), created, completed);
  touchChat(message.sessionID);
  return getMessage(message.id);
}
export function getMessage(id) { return messageRow(db.prepare('SELECT * FROM messages WHERE id=?').get(id)); }
export function listMessages(sessionId) {
  return db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at,rowid').all(sessionId).map(messageRow);
}
export function deleteMessagesFrom(sessionId, messageId) {
  const row = db.prepare('SELECT created_at,rowid FROM messages WHERE session_id=? AND id=?').get(sessionId, messageId);
  if (!row) return 0;
  return db.prepare('DELETE FROM messages WHERE session_id=? AND (created_at>? OR (created_at=? AND rowid>=?))')
    .run(sessionId, row.created_at, row.created_at, row.rowid).changes;
}

export function setTurn(sessionId, turn) {
  db.prepare(`INSERT INTO turns(session_id,turn_id,lifecycle,verdict,reason,since,updated_at)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(session_id) DO UPDATE SET turn_id=excluded.turn_id,lifecycle=excluded.lifecycle,verdict=excluded.verdict,reason=excluded.reason,since=excluded.since,updated_at=excluded.updated_at`)
    .run(sessionId, turn.turnId, turn.lifecycle, turn.verdict ?? null, turn.reason ?? null, turn.since ?? Date.now(), Date.now());
}
export function getTurn(sessionId) {
  const row = db.prepare('SELECT * FROM turns WHERE session_id=?').get(sessionId);
  if (!row) return null;
  return { turnId: row.turn_id, lifecycle: row.lifecycle, verdict: row.verdict, reason: row.reason, since: row.since };
}
export function clearTurn(sessionId) { db.prepare('DELETE FROM turns WHERE session_id=?').run(sessionId); }


export function reserveTurnCapacity(sessionId, ownerId, { maxGlobal = 32, maxPerOwner = 4, ttlMs = 120_000, now = Date.now() } = {}) {
  const globalLimit = Math.min(Math.max(Number(maxGlobal) || 32, 1), 1024);
  const ownerLimit = Math.min(Math.max(Number(maxPerOwner) || 4, 1), globalLimit);
  const ttl = Math.min(Math.max(Number(ttlMs) || 120_000, 30_000), 30 * 60 * 1000);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM turn_capacity_leases WHERE expires_at<=?').run(now);
    const existing = db.prepare('SELECT owner_id FROM turn_capacity_leases WHERE session_id=?').get(sessionId);
    if (existing) {
      if (String(existing.owner_id) !== String(ownerId)) throw new Error('Turn capacity lease ownership mismatch');
      db.prepare('UPDATE turn_capacity_leases SET expires_at=?,updated_at=? WHERE session_id=?').run(now + ttl, now, sessionId);
      db.exec('COMMIT');
      return { ok: true, existing: true };
    }
    const globalCount = Number(db.prepare('SELECT COUNT(*) AS n FROM turn_capacity_leases').get()?.n || 0);
    const ownerCount = Number(db.prepare('SELECT COUNT(*) AS n FROM turn_capacity_leases WHERE owner_id=?').get(ownerId)?.n || 0);
    if (globalCount >= globalLimit || ownerCount >= ownerLimit) {
      db.exec('ROLLBACK');
      return { ok: false, reason: globalCount >= globalLimit ? 'global_limit' : 'owner_limit', globalCount, ownerCount, maxGlobal: globalLimit, maxPerOwner: ownerLimit };
    }
    db.prepare('INSERT INTO turn_capacity_leases(session_id,owner_id,expires_at,updated_at) VALUES(?,?,?,?)').run(sessionId, ownerId, now + ttl, now);
    db.exec('COMMIT');
    return { ok: true, existing: false, globalCount: globalCount + 1, ownerCount: ownerCount + 1 };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function renewTurnCapacity(sessionId, { ttlMs = 120_000, now = Date.now() } = {}) {
  const ttl = Math.min(Math.max(Number(ttlMs) || 120_000, 30_000), 30 * 60 * 1000);
  return db.prepare('UPDATE turn_capacity_leases SET expires_at=?,updated_at=? WHERE session_id=?').run(now + ttl, now, sessionId).changes > 0;
}

export function releaseTurnCapacity(sessionId) {
  return db.prepare('DELETE FROM turn_capacity_leases WHERE session_id=?').run(sessionId).changes > 0;
}

export function turnCapacityCounts(ownerId, now = Date.now()) {
  db.prepare('DELETE FROM turn_capacity_leases WHERE expires_at<=?').run(now);
  return {
    global: Number(db.prepare('SELECT COUNT(*) AS n FROM turn_capacity_leases').get()?.n || 0),
    owner: ownerId ? Number(db.prepare('SELECT COUNT(*) AS n FROM turn_capacity_leases WHERE owner_id=?').get(ownerId)?.n || 0) : 0,
  };
}

/**
 * Fail everything the previous process left mid-flight.
 *
 * `skipSessionIds` must list the sessions that have a resumable durable job:
 * rejecting their pending questions and permissions would destroy exactly the
 * state those jobs are about to resume.
 */
export function recoverInterruptedRuntimeState(options = {}) {
  const now = Date.now();
  const skip = [...new Set((options.skipSessionIds || []).map((id) => String(id || '')).filter(Boolean))];
  const notSkipped = skip.length ? ` AND session_id NOT IN (${skip.map(() => '?').join(',')})` : '';
  const interruptedLifecycles = "lifecycle IN ('running','waiting_permission','waiting_user_input')";

  const interrupted = db.prepare(`SELECT COUNT(*) c FROM turns WHERE ${interruptedLifecycles}${notSkipped}`).get(...skip).c;
  db.prepare(`UPDATE turns SET lifecycle='failed',verdict='failed',reason='runtime_restart',updated_at=? WHERE ${interruptedLifecycles}${notSkipped}`).run(now, ...skip);
  db.prepare(`UPDATE actions SET state='failed',result_json=?,updated_at=? WHERE state='running'${notSkipped}`).run(JSON.stringify({ error: 'Runtime restarted while action was running' }), now, ...skip);
  db.prepare(`UPDATE questions SET status='rejected',resolved_at=? WHERE status='pending'${notSkipped}`).run(now, ...skip);
  db.prepare(`UPDATE permissions SET status='rejected',response='reject',resolved_at=? WHERE status='pending'${notSkipped}`).run(now, ...skip);
  return Number(interrupted) || 0;
}

export function createQuestion(id, sessionId, questions) {
  db.prepare('INSERT INTO questions(id,session_id,questions_json,status,created_at) VALUES(?,?,?,?,?)')
    .run(id, sessionId, JSON.stringify(questions), 'pending', Date.now());
}
export function listPendingQuestions(sessionId) {
  return db.prepare("SELECT * FROM questions WHERE session_id=? AND status='pending' ORDER BY created_at").all(sessionId).map((r) => ({ id: r.id, sessionID: r.session_id, questions: parse(r.questions_json, []) }));
}
export function resolveQuestion(id, answers, status = 'answered') {
  db.prepare('UPDATE questions SET status=?,answers_json=?,resolved_at=? WHERE id=?').run(status, JSON.stringify(answers ?? []), Date.now(), id);
}
export function getQuestion(id) {
  const r = db.prepare('SELECT * FROM questions WHERE id=?').get(id);
  return r ? { id:r.id,sessionID:r.session_id,questions:parse(r.questions_json,[]),answers:parse(r.answers_json,null),status:r.status } : null;
}
export function findQuestionForRecovery(sessionId, questions) {
  const row = db.prepare('SELECT id FROM questions WHERE session_id=? AND questions_json=? ORDER BY created_at DESC LIMIT 1')
    .get(sessionId, JSON.stringify(questions || []));
  return row?.id ? getQuestion(row.id) : null;
}

export function createPermission(id, sessionId, tool, input) {
  db.prepare('INSERT INTO permissions(id,session_id,tool,input_json,status,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, sessionId, tool, JSON.stringify(input ?? null), 'pending', Date.now());
}
export function resolvePermission(id, response) {
  db.prepare('UPDATE permissions SET status=?,response=?,resolved_at=? WHERE id=?').run(response === 'reject' ? 'rejected' : 'answered', response, Date.now(), id);
}
export function getPermission(id) {
  const r = db.prepare('SELECT * FROM permissions WHERE id=?').get(id);
  return r ? { id:r.id,sessionID:r.session_id,tool:r.tool,input:parse(r.input_json),response:r.response,status:r.status } : null;
}

export function getPrefs(ownerId) {
  const row = db.prepare('SELECT prefs_json FROM user_prefs WHERE owner_id=?').get(ownerId);
  return parse(row?.prefs_json, {}) || {};
}
export function setPrefs(ownerId, prefs) {
  db.prepare(`INSERT INTO user_prefs(owner_id,prefs_json,updated_at) VALUES(?,?,?)
              ON CONFLICT(owner_id) DO UPDATE SET prefs_json=excluded.prefs_json,updated_at=excluded.updated_at`)
    .run(ownerId, JSON.stringify(prefs || {}), Date.now());
  return prefs || {};
}

export function listProviderKeys(ownerId) {
  return Object.fromEntries(db.prepare('SELECT provider_id,api_key FROM provider_keys WHERE owner_id=?').all(ownerId).map((r) => [r.provider_id, decryptSecret(r.api_key, `provider:${ownerId}:${r.provider_id}:api_key`)]));
}
export function listProviderKeyIds(ownerId) {
  return db.prepare('SELECT provider_id FROM provider_keys WHERE owner_id=? ORDER BY provider_id').all(ownerId).map((r) => r.provider_id);
}
export function getProviderKey(ownerId, providerId) {
  const stored = db.prepare('SELECT api_key FROM provider_keys WHERE owner_id=? AND provider_id=?').get(ownerId, providerId)?.api_key;
  return stored ? decryptSecret(stored, `provider:${ownerId}:${providerId}:api_key`) : null;
}
export function setProviderKey(ownerId, providerId, key) {
  const encrypted = encryptSecret(key, `provider:${ownerId}:${providerId}:api_key`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO provider_keys(owner_id,provider_id,api_key,updated_at) VALUES(?,?,?,?)
                ON CONFLICT(owner_id,provider_id) DO UPDATE SET api_key=excluded.api_key,updated_at=excluded.updated_at`)
      .run(ownerId, providerId, encrypted, Date.now());
    insertAuditEventInCurrentTransaction({ actor: ownerId, action: 'provider.secret_set', target: providerId });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
export function deleteProviderKey(ownerId, providerId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const changes = db.prepare('DELETE FROM provider_keys WHERE owner_id=? AND provider_id=?').run(ownerId, providerId).changes;
    if (changes) insertAuditEventInCurrentTransaction({ actor: ownerId, action: 'provider.secret_delete', target: providerId });
    db.exec('COMMIT');
    return Boolean(changes);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function manualRow(r) { return { model_id:r.model_id,name:r.name ?? null,base_url:r.base_url ?? null,is_free:Boolean(r.is_free),pattern:Boolean(r.pattern),enabled:Boolean(r.enabled) }; }
export function listManualModels(ownerId, providerId = null) {
  const rows = providerId
    ? db.prepare('SELECT * FROM provider_models WHERE owner_id=? AND provider_id=? ORDER BY created_at').all(ownerId, providerId)
    : db.prepare('SELECT * FROM provider_models WHERE owner_id=? ORDER BY provider_id,created_at').all(ownerId);
  return rows.map(manualRow);
}
export function upsertManualModel(ownerId, providerId, model) {
  db.prepare(`INSERT INTO provider_models(owner_id,provider_id,model_id,name,base_url,is_free,pattern,enabled,created_at)
              VALUES(?,?,?,?,?,?,?,?,?)
              ON CONFLICT(owner_id,provider_id,model_id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,is_free=excluded.is_free,pattern=excluded.pattern,enabled=excluded.enabled`)
    .run(ownerId, providerId, model.modelId, model.name ?? null, model.baseUrl ?? null, model.isFree ? 1 : 0, model.pattern ? 1 : 0, model.enabled === false ? 0 : 1, Date.now());
}
export function deleteManualModel(ownerId, providerId, modelId) {
  db.prepare('DELETE FROM provider_models WHERE owner_id=? AND provider_id=? AND model_id=?').run(ownerId, providerId, modelId);
}
export function listHiddenModels(ownerId, providerId) {
  return db.prepare('SELECT model_id FROM hidden_models WHERE owner_id=? AND provider_id=? ORDER BY created_at').all(ownerId, providerId).map((r) => r.model_id);
}
export function setHiddenModel(ownerId, providerId, modelId, hidden) {
  if (hidden) db.prepare('INSERT OR IGNORE INTO hidden_models(owner_id,provider_id,model_id,created_at) VALUES(?,?,?,?)').run(ownerId, providerId, modelId, Date.now());
  else db.prepare('DELETE FROM hidden_models WHERE owner_id=? AND provider_id=? AND model_id=?').run(ownerId, providerId, modelId);
}



export function getAction(sessionId, actionId) {
  const r = db.prepare('SELECT * FROM actions WHERE session_id=? AND action_id=?').get(sessionId, actionId);
  return r ? { sessionId:r.session_id,actionId:r.action_id,state:r.state,result:parse(r.result_json,null),createdAt:r.created_at,updatedAt:r.updated_at } : null;
}
export function claimAction(sessionId, actionId) {
  const now = Date.now();
  const result = db.prepare('INSERT OR IGNORE INTO actions(session_id,action_id,state,created_at,updated_at) VALUES(?,?,?,?,?)').run(sessionId, actionId, 'running', now, now);
  return result.changes > 0;
}
export function completeAction(sessionId, actionId, result) {
  db.prepare('UPDATE actions SET state=?,result_json=?,updated_at=? WHERE session_id=? AND action_id=?').run('completed', JSON.stringify(result ?? null), Date.now(), sessionId, actionId);
}
export function failAction(sessionId, actionId, error) {
  db.prepare('UPDATE actions SET state=?,result_json=?,updated_at=? WHERE session_id=? AND action_id=?').run('failed', JSON.stringify({ error:String(error?.message || error) }), Date.now(), sessionId, actionId);
}
/**
 * Re-arm a failed idempotency key so the client can retry the same submission.
 * Completed actions are never reset: replaying them must keep returning the
 * stored result.
 */
export function resetAction(sessionId, actionId) {
  return db.prepare("UPDATE actions SET state='running',result_json=NULL,updated_at=? WHERE session_id=? AND action_id=? AND state='failed'")
    .run(Date.now(), sessionId, actionId).changes > 0;
}

export function listQueue(sessionId) {
  return db.prepare('SELECT action_id,payload_json,created_at FROM action_queue WHERE session_id=? ORDER BY created_at').all(sessionId).map((r) => ({ actionId:r.action_id,payload:parse(r.payload_json,{}),createdAt:r.created_at }));
}
export function enqueueAction(sessionId, actionId, payload) {
  const result = db.prepare('INSERT OR IGNORE INTO action_queue(session_id,action_id,payload_json,created_at) VALUES(?,?,?,?)').run(sessionId, actionId, JSON.stringify(payload || {}), Date.now());
  return result.changes ? 'queued' : 'duplicate';
}
export function dequeueAction(sessionId, actionId) {
  return Boolean(db.prepare('DELETE FROM action_queue WHERE session_id=? AND action_id=?').run(sessionId, actionId).changes);
}

function sanitizeAuditDetails(details) {
  const source = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const safe = {};
  for (const [rawKey, rawValue] of Object.entries(source).slice(0, 32)) {
    const key = String(rawKey).slice(0, 80);
    if (/pass(word)?|secret|token|api.?key|authorization|cookie|credential/i.test(key)) {
      safe[key] = '[redacted]';
      continue;
    }
    if (rawValue === null || ['boolean', 'number'].includes(typeof rawValue)) safe[key] = rawValue;
    else if (typeof rawValue === 'string') safe[key] = rawValue.slice(0, 512);
    else safe[key] = '[structured]';
  }
  const json = JSON.stringify(safe);
  return Buffer.byteLength(json) <= 8192 ? json : JSON.stringify({ truncated: true });
}

/**
 * Append a tamper-evident security audit event. User/account and target values
 * are HMAC-pseudonymised before persistence; request bodies and secrets are
 * never accepted. The chain is serialized with BEGIN IMMEDIATE so concurrent
 * requests cannot fork the previous-hash head.
 */
function insertAuditEventInCurrentTransaction({ actor = '', action, target = '', details = {} } = {}) {
  const actionText = String(action || '').trim();
  if (!/^[a-z0-9_.:-]{2,96}$/i.test(actionText)) throw new Error('Invalid audit action');
  const event = {
    event_id: crypto.randomUUID(), ts: Date.now(), actor_hash: auditIdentity(actor), action: actionText,
    target_hash: auditTarget(target), detail_json: sanitizeAuditDetails(details),
    prev_hash: String(db.prepare('SELECT event_hash FROM audit_events ORDER BY seq DESC LIMIT 1').get()?.event_hash || ''),
  };
  const eventHash = signAuditEvent(event);
  db.prepare(`INSERT INTO audit_events(event_id,ts,actor_hash,action,target_hash,detail_json,prev_hash,event_hash)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(event.event_id, event.ts, event.actor_hash, event.action, event.target_hash, event.detail_json, event.prev_hash, eventHash);
  return { eventId: event.event_id, eventHash };
}

export function recordAuditEvent(event) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = insertAuditEventInCurrentTransaction(event);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function verifyAuditLog() {
  const rows = db.prepare('SELECT seq,event_id,ts,actor_hash,action,target_hash,detail_json,prev_hash,event_hash FROM audit_events ORDER BY seq').all();
  return verifyAuditRows(rows);
}

export function auditEventCount() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()?.n || 0);
}

export function closeStore() { db.close(); }

/** Lightweight readiness probe. Performs a real SQLite write inside runtime_meta
 * so a read-only/corrupt/full database cannot report ready merely because SELECT works. */
export function storeReadinessCheck() {
  const now = Date.now();
  const row = db.prepare('SELECT 1 AS ok').get();
  if (row?.ok !== 1) throw new Error('SQLite read probe failed');
  // Prove writes are possible without turning every readiness probe into a
  // persistent WAL write. The savepoint is synchronous on this connection and
  // rolls the probe row back before returning.
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
    ok: true, journalMode: String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || ''),
    schemaVersion: schema.currentVersion, expectedSchemaVersion: LATEST_SCHEMA_VERSION, newerCompatible: schema.newerCompatible, at: now,
  };
}
