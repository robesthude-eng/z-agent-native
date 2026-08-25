import crypto from 'node:crypto';
import { db } from './db.mjs';
import { auditIdentity, auditTarget, signAuditEvent, verifyAuditRows } from '../audit.mjs';

const parse = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

export function getAction(sessionId, actionId) {
  const r = db.prepare('SELECT * FROM actions WHERE session_id=? AND action_id=?').get(sessionId, actionId);
  return r ? { sessionId: r.session_id, actionId: r.action_id, state: r.state, result: parse(r.result_json, null), createdAt: r.created_at, updatedAt: r.updated_at } : null;
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
  db.prepare('UPDATE actions SET state=?,result_json=?,updated_at=? WHERE session_id=? AND action_id=?').run('failed', JSON.stringify({ error: String(error?.message || error) }), Date.now(), sessionId, actionId);
}

export function resetAction(sessionId, actionId) {
  return db.prepare("UPDATE actions SET state='running',result_json=NULL,updated_at=? WHERE session_id=? AND action_id=? AND state='failed'")
    .run(Date.now(), sessionId, actionId).changes > 0;
}

export function listQueue(sessionId) {
  return db.prepare('SELECT action_id,payload_json,created_at FROM action_queue WHERE session_id=? ORDER BY created_at').all(sessionId).map((r) => ({ actionId: r.action_id, payload: parse(r.payload_json, {}), createdAt: r.created_at }));
}

export function enqueueAction(sessionId, actionId, payload) {
  const result = db.prepare('INSERT OR IGNORE INTO action_queue(session_id,action_id,payload_json,created_at) VALUES(?,?,?,?)').run(sessionId, actionId, JSON.stringify(payload || {}), Date.now());
  return result.changes ? 'queued' : 'duplicate';
}

export function dequeueAction(sessionId, actionId) {
  return Boolean(db.prepare('DELETE FROM action_queue WHERE session_id=? AND action_id=?').run(sessionId, actionId).changes);
}

export function sanitizeAuditDetails(details) {
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

export function insertAuditEventInCurrentTransaction({ actor = '', action, target = '', details = {} } = {}) {
  const actionText = String(action || '').trim();
  if (!/^[a-z0-9_.:-]{2,96}$/i.test(actionText)) throw new Error('Invalid audit action');
  const event = {
    event_id: crypto.randomUUID(),
    ts: Date.now(),
    actor_hash: auditIdentity(actor),
    action: actionText,
    target_hash: auditTarget(target),
    detail_json: sanitizeAuditDetails(details),
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
