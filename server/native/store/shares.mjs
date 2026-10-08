// Публичные ссылки «только чтение» на чат. Одна ссылка на чат; токен
// случайный (192 бита), отзыв — удаление строки. Удаление чата убирает
// ссылку каскадом.
import crypto from 'node:crypto';
import { insertAuditEventInCurrentTransaction } from './actions.mjs';
import { db } from './db.mjs';

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function shareRow(row) {
  return row ? { token: row.token, sessionId: row.session_id, created: row.created_at } : null;
}

export function getChatShare(sessionId, ownerId) {
  return shareRow(db.prepare('SELECT * FROM chat_shares WHERE session_id=? AND owner_id=?').get(sessionId, ownerId));
}

export function createChatShare(sessionId, ownerId) {
  const existing = getChatShare(sessionId, ownerId);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('base64url');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO chat_shares(token,session_id,owner_id,created_at) VALUES(?,?,?,?)').run(token, sessionId, ownerId, Date.now());
    insertAuditEventInCurrentTransaction({ actor: ownerId, action: 'chat.share', target: sessionId });
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
  return getChatShare(sessionId, ownerId);
}

export function deleteChatShare(sessionId, ownerId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const changes = db.prepare('DELETE FROM chat_shares WHERE session_id=? AND owner_id=?').run(sessionId, ownerId).changes;
    if (changes) insertAuditEventInCurrentTransaction({ actor: ownerId, action: 'chat.unshare', target: sessionId });
    db.exec('COMMIT');
    return Boolean(changes);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

export function listChatShares(ownerId) {
  return db
    .prepare(`SELECT s.token,s.session_id,s.created_at,c.title FROM chat_shares s
                     JOIN chats c ON c.id=s.session_id WHERE s.owner_id=? ORDER BY s.created_at DESC`)
    .all(ownerId)
    .map((row) => ({ ...shareRow(row), title: row.title }));
}

export function resolveChatShare(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = db
    .prepare(`SELECT s.token,s.session_id,s.created_at,c.title,c.updated_at FROM chat_shares s
                          JOIN chats c ON c.id=s.session_id WHERE s.token=?`)
    .get(token);
  return row ? { sessionId: row.session_id, title: row.title, created: row.created_at, updated: row.updated_at } : null;
}
