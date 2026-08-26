import crypto from 'node:crypto';
import { insertAuditEventInCurrentTransaction } from './actions.mjs';
import { db } from './db.mjs';

export function authSessionKey(token) {
  const value = String(token || '');
  if (!value) return '';
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

// Migrate legacy plaintext auth session keys if any
for (const row of db.prepare("SELECT token FROM auth_sessions WHERE token NOT LIKE 'sha256:%'").all()) {
  db.prepare('UPDATE auth_sessions SET token=? WHERE token=?').run(authSessionKey(row.token), row.token);
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

export function userCount() {
  return db.prepare('SELECT COUNT(*) c FROM users').get().c;
}

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

export function pruneAuthSessions(before) {
  db.prepare('DELETE FROM auth_sessions WHERE created_at < ?').run(before);
}

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
