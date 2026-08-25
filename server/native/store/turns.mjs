import { db } from './db.mjs';

const parse = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

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

export function clearTurn(sessionId) {
  db.prepare('DELETE FROM turns WHERE session_id=?').run(sessionId);
}

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
  return r ? { id: r.id, sessionID: r.session_id, questions: parse(r.questions_json, []), answers: parse(r.answers_json, null), status: r.status } : null;
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
  return r ? { id: r.id, sessionID: r.session_id, tool: r.tool, input: parse(r.input_json), response: r.response, status: r.status } : null;
}
