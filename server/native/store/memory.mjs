// Долговременная память агента (факты и уроки) и библиотека навыков.
// Память бывает общей (scope='global') или привязанной к чату (scope=id чата).
import crypto from 'node:crypto';
import { db } from './db.mjs';

export const MEMORY_KINDS = ['fact', 'preference', 'lesson'];
export const MAX_MEMORY_TEXT = 600;
export const MAX_MEMORY_ITEMS = 300;
export const MAX_SKILL_CONTENT = 96_000;
export const MAX_SKILLS = 500;

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

function memoryRow(row) {
  return row ? { id: row.id, scope: row.scope, kind: row.kind, text: row.text, source: row.source, created: row.created_at } : null;
}

export function listMemory(ownerId, { sessionId = null, includeAllChats = false } = {}) {
  const rows = includeAllChats
    ? db.prepare('SELECT * FROM agent_memory WHERE owner_id=? ORDER BY created_at').all(ownerId)
    : db.prepare("SELECT * FROM agent_memory WHERE owner_id=? AND (scope='global' OR scope=?) ORDER BY created_at").all(ownerId, sessionId || '');
  return rows.map(memoryRow);
}

export function addMemory(ownerId, { text, kind = 'fact', scope = 'global', source = 'agent' }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_TEXT);
  if (!clean) throw Object.assign(new Error('Memory text is empty'), { statusCode: 400 });
  const k = MEMORY_KINDS.includes(kind) ? kind : 'fact';
  const sc = String(scope || 'global');
  // SQLite lower() не знает кириллицу — сравниваем в JS.
  const lc = clean.toLocaleLowerCase('ru');
  const dup = db.prepare('SELECT * FROM agent_memory WHERE owner_id=? AND scope=?').all(ownerId, sc).find((r) => r.text.toLocaleLowerCase('ru') === lc);
  if (dup) return { ...memoryRow(dup), duplicate: true };
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM agent_memory WHERE owner_id=?').get(ownerId)?.n || 0);
  if (count >= MAX_MEMORY_ITEMS) {
    throw Object.assign(new Error(`Memory is full (${MAX_MEMORY_ITEMS} entries). Remove outdated entries first.`), { statusCode: 409 });
  }
  const row = { id: id('mem'), created: Date.now() };
  db.prepare('INSERT INTO agent_memory(id,owner_id,scope,kind,text,source,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(row.id, ownerId, sc, k, clean, source === 'user' ? 'user' : 'agent', row.created);
  return memoryRow(db.prepare('SELECT * FROM agent_memory WHERE id=?').get(row.id));
}

export function updateMemory(ownerId, memoryId, { text, kind }) {
  const cur = db.prepare('SELECT * FROM agent_memory WHERE id=? AND owner_id=?').get(memoryId, ownerId);
  if (!cur) return null;
  const clean = text == null ? cur.text : String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_TEXT);
  const k = MEMORY_KINDS.includes(kind) ? kind : cur.kind;
  if (!clean) return null;
  db.prepare('UPDATE agent_memory SET text=?,kind=? WHERE id=?').run(clean, k, memoryId);
  return memoryRow(db.prepare('SELECT * FROM agent_memory WHERE id=?').get(memoryId));
}

export function removeMemory(ownerId, memoryId) {
  return Boolean(db.prepare('DELETE FROM agent_memory WHERE id=? AND owner_id=?').run(memoryId, ownerId).changes);
}

export function clearChatMemory(sessionId) {
  db.prepare('DELETE FROM agent_memory WHERE scope=?').run(String(sessionId || ''));
}

export function normalizeSkillName(raw) {
  return String(raw || '').toLowerCase().trim().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function skillRow(row, withContent = true) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, description: row.description, uses: row.uses,
    created: row.created_at, updated: row.updated_at, ...(withContent ? { content: row.content } : {}),
    enabled: row.enabled !== 0, autoUse: row.auto_use !== 0,
    source: JSON.parse(row.source_json || '{}'), warnings: JSON.parse(row.warnings_json || '[]'),
  };
}

export function listSkills(ownerId, { withContent = false } = {}) {
  return db.prepare(`SELECT id,name,description,uses,created_at,updated_at,enabled,auto_use,source_json,warnings_json${withContent ? ',content' : ''} FROM agent_skills WHERE owner_id=? ORDER BY uses DESC, updated_at DESC`).all(ownerId).map((r) => skillRow(r, withContent));
}

export function getSkill(ownerId, name, { countUse = false } = {}) {
  const n = normalizeSkillName(name);
  const row = db.prepare('SELECT * FROM agent_skills WHERE owner_id=? AND (name=? OR id=?)').get(ownerId, n, String(name || ''));
  if (row && countUse) db.prepare('UPDATE agent_skills SET uses=uses+1 WHERE id=?').run(row.id);
  return skillRow(row);
}

export function saveSkill(ownerId, { name, description, content }) {
  const n = normalizeSkillName(name);
  if (!n) throw Object.assign(new Error('Skill name is required'), { statusCode: 400 });
  const desc = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 1024);
  const body = String(content || '').trim().slice(0, MAX_SKILL_CONTENT);
  if (!desc || !body) throw Object.assign(new Error('Skill description and content are required'), { statusCode: 400 });
  const now = Date.now();
  const existing = db.prepare('SELECT id,source_json FROM agent_skills WHERE owner_id=? AND name=?').get(ownerId, n);
  if (existing) {
    db.prepare('UPDATE agent_skills SET description=?,content=?,updated_at=? WHERE id=?').run(desc, body, now, existing.id);
    const source = JSON.parse(existing.source_json || '{}');
    if (source.type) db.prepare('UPDATE agent_skills SET source_json=? WHERE id=?').run(JSON.stringify({ ...source, modified: true }), existing.id);
    return { ...skillRow(db.prepare('SELECT * FROM agent_skills WHERE id=?').get(existing.id)), updatedExisting: true };
  }
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM agent_skills WHERE owner_id=?').get(ownerId)?.n || 0);
  if (count >= MAX_SKILLS) throw Object.assign(new Error(`Skill library is full (${MAX_SKILLS}).`), { statusCode: 409 });
  const sid = id('skl');
  db.prepare('INSERT INTO agent_skills(id,owner_id,name,description,content,uses,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)')
    .run(sid, ownerId, n, desc, body, now, now);
  return skillRow(db.prepare('SELECT * FROM agent_skills WHERE id=?').get(sid));
}

export function deleteSkill(ownerId, nameOrId) {
  const n = normalizeSkillName(nameOrId);
  return Boolean(db.prepare('DELETE FROM agent_skills WHERE owner_id=? AND (name=? OR id=?)').run(ownerId, n, String(nameOrId || '')).changes);
}
