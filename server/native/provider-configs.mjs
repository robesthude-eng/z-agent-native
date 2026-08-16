import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.mjs';

export const PROVIDER_PROTOCOLS = ['openai', 'anthropic', 'google'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS provider_configs (
    owner_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_custom INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, provider_id),
    FOREIGN KEY(owner_id) REFERENCES users(email) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_provider_configs_owner ON provider_configs(owner_id, updated_at DESC);
`);

function cleanName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) throw Object.assign(new Error('Название провайдера должно содержать от 1 до 80 символов'), { statusCode: 400 });
  return name;
}

function cleanProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase();
  if (!PROVIDER_PROTOCOLS.includes(protocol)) throw Object.assign(new Error('Протокол должен быть openai, anthropic или google'), { statusCode: 400 });
  return protocol;
}

function cleanBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('Некорректный API Base URL'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('API Base URL должен быть HTTP(S) URL без логина/пароля'), { statusCode: 400 });
  }
  if (raw.length > 2000) throw Object.assign(new Error('API Base URL слишком длинный'), { statusCode: 400 });
  return raw;
}

function rowToConfig(row) {
  return row ? {
    id: row.provider_id,
    name: row.name,
    protocol: row.protocol,
    baseURL: row.base_url,
    enabled: Boolean(row.enabled),
    custom: Boolean(row.is_custom),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

export function newCustomProviderId() {
  return `channel_${crypto.randomBytes(8).toString('hex')}`;
}

export function listProviderConfigs(ownerId) {
  return db.prepare('SELECT * FROM provider_configs WHERE owner_id=? ORDER BY created_at,provider_id').all(ownerId).map(rowToConfig);
}

export function getProviderConfig(ownerId, providerId) {
  return rowToConfig(db.prepare('SELECT * FROM provider_configs WHERE owner_id=? AND provider_id=?').get(ownerId, providerId));
}

export function upsertProviderConfig(ownerId, input, { custom = true } = {}) {
  const providerId = String(input?.id || '').trim();
  if (!/^[A-Za-z0-9._:-]{2,120}$/.test(providerId)) throw Object.assign(new Error('Некорректный provider id'), { statusCode: 400 });
  const name = cleanName(input?.name);
  const protocol = cleanProtocol(input?.protocol);
  const baseURL = cleanBaseUrl(input?.baseURL);
  const enabled = input?.enabled !== false;
  const now = Date.now();
  db.prepare(`INSERT INTO provider_configs(owner_id,provider_id,name,protocol,base_url,enabled,is_custom,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?)
              ON CONFLICT(owner_id,provider_id) DO UPDATE SET
                name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,
                enabled=excluded.enabled,is_custom=excluded.is_custom,updated_at=excluded.updated_at`)
    .run(ownerId, providerId, name, protocol, baseURL, enabled ? 1 : 0, custom ? 1 : 0, now, now);
  return getProviderConfig(ownerId, providerId);
}

export function deleteProviderConfig(ownerId, providerId, { deleteData = false } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM provider_configs WHERE owner_id=? AND provider_id=?').run(ownerId, providerId);
    if (deleteData) {
      db.prepare('DELETE FROM provider_keys WHERE owner_id=? AND provider_id=?').run(ownerId, providerId);
      db.prepare('DELETE FROM provider_models WHERE owner_id=? AND provider_id=?').run(ownerId, providerId);
      db.prepare('DELETE FROM hidden_models WHERE owner_id=? AND provider_id=?').run(ownerId, providerId);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
