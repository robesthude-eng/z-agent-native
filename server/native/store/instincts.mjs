// «Инстинкты» — небольшие выученные привычки агента: «когда <триггер>, делай <действие>».
// Идея и шкала уверенности взяты из подхода continuous-learning (ECC, MIT); код независимый.
// Хранятся только обобщённые правила и короткая обезличенная выдержка-доказательство.
// Сырые наблюдения (переписка, вывод инструментов) не сохраняются нигде.
// scope: 'global' — для всех чатов владельца, иначе id чата. Между владельцами не пересекается.
import crypto from 'node:crypto';
import { db } from './db.mjs';

export const INSTINCT_DOMAINS = [
  'code-style',
  'testing',
  'git',
  'debugging',
  'workflow',
  'security',
  'communication',
  'tooling',
  'docs',
  'other',
];
// Только такие правила разрешено делать общими для всех чатов.
export const GLOBAL_DOMAINS = ['security', 'git', 'workflow', 'communication', 'tooling'];
export const MAX_INSTINCTS = 200;
export const MAX_TRIGGER = 160;
export const MAX_ACTION = 220;
export const MAX_EVIDENCE = 200;
export const MAX_CONFIDENCE = 0.9;
export const CONFIRM_STEP = 0.05;
export const CONTRADICT_STEP = 0.1;
export const DECAY_PER_WEEK = 0.02;
export const DROP_BELOW = 0.2;
export const PROMOTE_MIN_CHATS = 2;
export const PROMOTE_MIN_CONFIDENCE = 0.8;
export const SIMILARITY = 0.7;
const WEEK_MS = 7 * 24 * 3600 * 1000;

const newId = () => `ins_${crypto.randomBytes(9).toString('base64url')}`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round(n * 100) / 100;
const clean = (text, max) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Стартовая уверенность по числу независимых наблюдений. */
export function baseConfidence(observations) {
  const n = Number(observations) || 0;
  if (n >= 11) return 0.85;
  if (n >= 6) return 0.7;
  if (n >= 3) return 0.5;
  return 0.3;
}

/** Уверенность с учётом затухания (−0.02 за неделю без подтверждений). */
export function effectiveConfidence(row, now = Date.now()) {
  const weeks = Math.max(0, (now - Number(row.last_observed_at || row.updated_at || now)) / WEEK_MS);
  return round2(clamp(Number(row.confidence) - DECAY_PER_WEEK * weeks, 0, MAX_CONFIDENCE));
}

export function confidenceLabel(value) {
  if (value >= 0.7) return 'strong';
  if (value >= 0.5) return 'moderate';
  return 'tentative';
}

const tokenSet = (text) =>
  new Set(
    String(text || '')
      .toLocaleLowerCase('ru')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );

export function similarity(a, b) {
  const x = tokenSet(a);
  const y = tokenSet(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common += 1;
  return common / (x.size + y.size - common);
}

const sameRule = (row, trigger, action) => similarity(`${row.trigger_text} ${row.action_text}`, `${trigger} ${action}`) >= SIMILARITY;

function instinctRow(row, now = Date.now()) {
  return row
    ? {
        id: row.id,
        scope: row.scope,
        trigger: row.trigger_text,
        action: row.action_text,
        domain: row.domain,
        confidence: effectiveConfidence(row, now),
        observations: row.observations,
        contradictions: row.contradictions,
        evidence: row.evidence,
        source: row.source,
        status: row.status,
        created: row.created_at,
        updated: row.updated_at,
        lastObserved: row.last_observed_at,
      }
    : null;
}

const rawRow = (ownerId, id) => db.prepare('SELECT * FROM agent_instincts WHERE id=? AND owner_id=?').get(id, ownerId);

export function getInstinct(ownerId, id) {
  return instinctRow(rawRow(ownerId, String(id || '')));
}

export function listInstincts(ownerId, { sessionId = null, includeAllChats = false, includeDismissed = false } = {}) {
  const status = includeDismissed ? '' : " AND status='active'";
  const rows = includeAllChats
    ? db.prepare(`SELECT * FROM agent_instincts WHERE owner_id=?${status}`).all(ownerId)
    : db.prepare(`SELECT * FROM agent_instincts WHERE owner_id=? AND (scope='global' OR scope=?)${status}`).all(ownerId, sessionId || '');
  const now = Date.now();
  return rows.map((r) => instinctRow(r, now)).sort((a, b) => b.confidence - a.confidence || b.lastObserved - a.lastObserved);
}

function makeRoom(ownerId) {
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM agent_instincts WHERE owner_id=?').get(ownerId)?.n || 0);
  if (count < MAX_INSTINCTS) return true;
  // Освобождаем место: самый слабый активный инстинкт слабее порога «moderate». Отклонённые — метки, их не трогаем.
  const weakest = db
    .prepare("SELECT * FROM agent_instincts WHERE owner_id=? AND status='active'")
    .all(ownerId)
    .map((r) => ({ r, c: effectiveConfidence(r) }))
    .filter((x) => x.c < 0.5)
    .sort((a, b) => a.c - b.c)[0];
  if (!weakest) return false;
  db.prepare('DELETE FROM agent_instincts WHERE id=?').run(weakest.r.id);
  return true;
}

function bumpRow(row, now, { evidence } = {}) {
  const observations = row.observations + 1;
  const confidence = clamp(Math.max(effectiveConfidence(row, now) + CONFIRM_STEP, baseConfidence(observations)), 0, MAX_CONFIDENCE);
  db.prepare('UPDATE agent_instincts SET observations=?,confidence=?,evidence=?,updated_at=?,last_observed_at=? WHERE id=?').run(
    observations,
    round2(confidence),
    evidence ? clean(evidence, MAX_EVIDENCE) : row.evidence,
    now,
    now,
    row.id,
  );
}

/**
 * Добавляет инстинкт или подтверждает похожий в том же scope.
 * Отклонённый владельцем (status='dismissed') не воскрешается.
 * `explicit` — владелец прямо сформулировал правило: стартуем с «moderate».
 */
export function addInstinct(
  ownerId,
  { trigger, action, domain = 'other', scope = 'global', evidence = '', explicit = false, source = 'observer' },
) {
  const t = clean(trigger, MAX_TRIGGER);
  const a = clean(action, MAX_ACTION);
  if (!t || !a) throw Object.assign(new Error('Instinct trigger and action are required'), { statusCode: 400 });
  const sc = String(scope || 'global');
  const dom = INSTINCT_DOMAINS.includes(domain) ? domain : 'other';
  const now = Date.now();
  const same = db
    .prepare('SELECT * FROM agent_instincts WHERE owner_id=? AND scope=?')
    .all(ownerId, sc)
    .find((r) => sameRule(r, t, a));
  if (same) {
    if (same.status === 'dismissed') return { ...instinctRow(same, now), dismissed: true };
    bumpRow(same, now, { evidence });
    return { ...instinctRow(rawRow(ownerId, same.id)), confirmed: true };
  }
  // Правило уже есть в «общих» — не плодим копию для чата.
  if (sc !== 'global') {
    const global = db
      .prepare("SELECT * FROM agent_instincts WHERE owner_id=? AND scope='global'")
      .all(ownerId)
      .find((r) => sameRule(r, t, a));
    if (global) {
      if (global.status === 'dismissed') return { ...instinctRow(global, now), dismissed: true };
      bumpRow(global, now, { evidence });
      return { ...instinctRow(rawRow(ownerId, global.id)), confirmed: true };
    }
  }
  if (!makeRoom(ownerId)) {
    throw Object.assign(new Error(`Instinct store is full (${MAX_INSTINCTS}). Remove outdated entries first.`), { statusCode: 409 });
  }
  const row = {
    id: newId(),
    confidence: explicit ? 0.5 : baseConfidence(1),
  };
  db.prepare(
    `INSERT INTO agent_instincts(id,owner_id,scope,trigger_text,action_text,domain,confidence,observations,contradictions,evidence,source,status,created_at,updated_at,last_observed_at)
     VALUES(?,?,?,?,?,?,?,1,0,?,?,'active',?,?,?)`,
  ).run(
    row.id,
    ownerId,
    sc,
    t,
    a,
    dom,
    row.confidence,
    clean(evidence, MAX_EVIDENCE),
    ['user', 'import'].includes(source) ? source : 'observer',
    now,
    now,
    now,
  );
  return { ...instinctRow(rawRow(ownerId, row.id)), created: true };
}

export function confirmInstinct(ownerId, id) {
  const row = rawRow(ownerId, String(id || ''));
  if (row?.status !== 'active') return null;
  bumpRow(row, Date.now());
  return instinctRow(rawRow(ownerId, row.id));
}

/** Противоречие: −0.1; ниже 0.2 инстинкт забывается. */
export function contradictInstinct(ownerId, id) {
  const row = rawRow(ownerId, String(id || ''));
  if (row?.status !== 'active') return null;
  const now = Date.now();
  const confidence = round2(effectiveConfidence(row, now) - CONTRADICT_STEP);
  if (confidence < DROP_BELOW) {
    db.prepare('DELETE FROM agent_instincts WHERE id=?').run(row.id);
    return { id: row.id, removed: true };
  }
  db.prepare('UPDATE agent_instincts SET confidence=?,contradictions=contradictions+1,updated_at=?,last_observed_at=? WHERE id=?').run(
    confidence,
    now,
    now,
    row.id,
  );
  return instinctRow(rawRow(ownerId, row.id));
}

export function setInstinctStatus(ownerId, id, status) {
  if (!['active', 'dismissed'].includes(status)) throw Object.assign(new Error('Invalid status'), { statusCode: 400 });
  const row = rawRow(ownerId, String(id || ''));
  if (!row) return null;
  db.prepare('UPDATE agent_instincts SET status=?,updated_at=? WHERE id=?').run(status, Date.now(), row.id);
  return instinctRow(rawRow(ownerId, row.id));
}

export function removeInstinct(ownerId, id) {
  return Boolean(db.prepare('DELETE FROM agent_instincts WHERE id=? AND owner_id=?').run(String(id || ''), ownerId).changes);
}

export function clearChatInstincts(sessionId) {
  const sid = String(sessionId || '');
  if (!sid || sid === 'global') return;
  db.prepare('DELETE FROM agent_instincts WHERE scope=?').run(sid);
}

/** Ручное «сделать общим»: только для доменов, безопасных для всех чатов. */
export function promoteInstinct(ownerId, id) {
  const row = rawRow(ownerId, String(id || ''));
  if (!row) return null;
  if (row.scope === 'global') return instinctRow(row);
  if (!GLOBAL_DOMAINS.includes(row.domain)) {
    throw Object.assign(new Error(`Instincts of domain "${row.domain}" stay in their chat`), { statusCode: 409 });
  }
  const dup = db
    .prepare("SELECT * FROM agent_instincts WHERE owner_id=? AND scope='global'")
    .all(ownerId)
    .find((r) => sameRule(r, row.trigger_text, row.action_text));
  if (dup) {
    db.prepare('UPDATE agent_instincts SET confidence=?,observations=?,updated_at=?,last_observed_at=? WHERE id=?').run(
      Math.max(effectiveConfidence(dup), effectiveConfidence(row)),
      dup.observations + row.observations,
      Date.now(),
      Date.now(),
      dup.id,
    );
    db.prepare('DELETE FROM agent_instincts WHERE id=?').run(row.id);
    return instinctRow(rawRow(ownerId, dup.id));
  }
  db.prepare("UPDATE agent_instincts SET scope='global',updated_at=? WHERE id=?").run(Date.now(), row.id);
  return instinctRow(rawRow(ownerId, row.id));
}

/**
 * Автоповышение (как в ECC): один и тот же паттерн в ≥2 чатах, средняя
 * уверенность ≥0.8, домен безопасен для всех чатов → правило становится общим.
 */
export function promoteRecurringInstincts(ownerId) {
  const now = Date.now();
  const rows = db
    .prepare("SELECT * FROM agent_instincts WHERE owner_id=? AND status='active' AND scope<>'global'")
    .all(ownerId)
    .filter((r) => GLOBAL_DOMAINS.includes(r.domain));
  const used = new Set();
  const promoted = [];
  for (const seed of rows) {
    if (used.has(seed.id)) continue;
    const group = rows.filter((r) => !used.has(r.id) && sameRule(r, seed.trigger_text, seed.action_text));
    const chats = new Set(group.map((r) => r.scope));
    if (chats.size < PROMOTE_MIN_CHATS) continue;
    const avg = group.reduce((sum, r) => sum + effectiveConfidence(r, now), 0) / group.length;
    if (avg < PROMOTE_MIN_CONFIDENCE) continue;
    for (const r of group) used.add(r.id);
    const best = group.slice().sort((a, b) => effectiveConfidence(b, now) - effectiveConfidence(a, now))[0];
    const merged = addInstinct(ownerId, {
      trigger: best.trigger_text,
      action: best.action_text,
      domain: best.domain,
      scope: 'global',
      evidence: best.evidence,
      source: 'observer',
    });
    if (!merged.dismissed) {
      db.prepare('UPDATE agent_instincts SET confidence=?,observations=?,updated_at=? WHERE id=?').run(
        round2(clamp(avg, 0, MAX_CONFIDENCE)),
        group.reduce((n, r) => n + r.observations, 0),
        now,
        merged.id,
      );
      promoted.push(merged.id);
    }
    for (const r of group) db.prepare('DELETE FROM agent_instincts WHERE id=?').run(r.id);
  }
  return promoted;
}

/** Экспорт: только обобщённые правила, без доказательств, id чатов и сырых наблюдений. */
export function exportInstincts(ownerId) {
  return {
    format: 'zagent-instincts',
    version: 1,
    instincts: listInstincts(ownerId, { includeAllChats: true }).map((i) => ({
      trigger: i.trigger,
      action: i.action,
      domain: i.domain,
      confidence: i.confidence,
    })),
  };
}

/** Импорт: чужая уверенность не доверяется — максимум «moderate», всегда общий scope. */
export function importInstincts(ownerId, items, { validate = (text, max) => clean(text, max) } = {}) {
  const result = { imported: 0, skipped: 0 };
  for (const item of Array.isArray(items) ? items.slice(0, MAX_INSTINCTS) : []) {
    const trigger = validate(item?.trigger, MAX_TRIGGER);
    const action = validate(item?.action, MAX_ACTION);
    if (!trigger || !action) {
      result.skipped += 1;
      continue;
    }
    try {
      const saved = addInstinct(ownerId, {
        trigger,
        action,
        domain: GLOBAL_DOMAINS.includes(item?.domain) ? item.domain : 'other',
        scope: 'global',
        source: 'import',
        explicit: true,
      });
      if (saved.dismissed) result.skipped += 1;
      else result.imported += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}
