import { db } from './db.mjs';
import { touchChat } from './chats.mjs';

const parse = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

export function messageRow(row) {
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
  const created = Math.min(Number(message.time?.created) || Date.now(), Date.now());
  const completed = message.time?.completed || message.info?.time?.completed || null;
  db.prepare(`INSERT INTO messages(id,session_id,role,parts_json,info_json,created_at,completed_at)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET parts_json=excluded.parts_json,info_json=excluded.info_json,completed_at=excluded.completed_at`)
    .run(message.id, message.sessionID, message.role, JSON.stringify(message.parts || []), JSON.stringify(message.info || {}), created, completed);
  touchChat(message.sessionID);
  return getMessage(message.id);
}

export function getMessage(id) {
  return messageRow(db.prepare('SELECT * FROM messages WHERE id=?').get(id));
}

export function listMessages(sessionId) {
  return db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at,rowid').all(sessionId).map(messageRow);
}

export function deleteMessagesFrom(sessionId, messageId) {
  const row = db.prepare('SELECT created_at,rowid FROM messages WHERE session_id=? AND id=?').get(sessionId, messageId);
  if (!row) return 0;
  return db.prepare('DELETE FROM messages WHERE session_id=? AND (created_at>? OR (created_at=? AND rowid>=?))')
    .run(sessionId, row.created_at, row.created_at, row.rowid).changes;
}
