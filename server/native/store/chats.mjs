import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.mjs';
import { WORKSPACES_DIR } from '../config.mjs';
import { insertAuditEventInCurrentTransaction } from './actions.mjs';

function bootstrapSandboxUids() {
  const minUid = 20_000;
  const maxExisting = Number(db.prepare('SELECT MAX(sandbox_uid) AS m FROM chats').get()?.m || 0);
  const wanted = Math.max(minUid, maxExisting + 1);
  db.prepare("INSERT INTO runtime_meta(key,value) VALUES('sandbox_uid_next',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(wanted));
}

bootstrapSandboxUids();

export function allocateSandboxUid() {
  db.prepare("INSERT OR IGNORE INTO runtime_meta(key,value) VALUES('sandbox_uid_next','20000')").run();
  const row = db.prepare("UPDATE runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='sandbox_uid_next' RETURNING value").get();
  return Number(row?.value || 20000);
}

export function workspaceFor(sessionId) {
  const root = path.join(WORKSPACES_DIR, sessionId);
  fs.mkdirSync(root, { recursive: true });
  try { fs.chmodSync(root, 0o700); } catch {}
  return root;
}

export function chatRow(row) {
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

export function touchChat(id) {
  db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(Date.now(), id);
}

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
