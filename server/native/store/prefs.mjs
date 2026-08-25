import { db } from './db.mjs';
import { decryptSecret, encryptSecret, rewrapSecret } from '../secrets.mjs';
import { insertAuditEventInCurrentTransaction } from './actions.mjs';

const parse = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

// Provider secret migration / rotation on startup
for (const row of db.prepare('SELECT owner_id,provider_id,api_key FROM provider_keys').all()) {
  const aad = `provider:${row.owner_id}:${row.provider_id}:api_key`;
  const next = rewrapSecret(row.api_key, aad);
  if (next !== row.api_key) {
    db.prepare('UPDATE provider_keys SET api_key=?,updated_at=? WHERE owner_id=? AND provider_id=?')
      .run(next, Date.now(), row.owner_id, row.provider_id);
  }
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
  return Object.fromEntries(
    db.prepare('SELECT provider_id,api_key FROM provider_keys WHERE owner_id=?')
      .all(ownerId)
      .map((r) => [r.provider_id, decryptSecret(r.api_key, `provider:${ownerId}:${r.provider_id}:api_key`)])
  );
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

function manualRow(r) {
  return {
    model_id: r.model_id,
    name: r.name ?? null,
    base_url: r.base_url ?? null,
    is_free: Boolean(r.is_free),
    pattern: Boolean(r.pattern),
    enabled: Boolean(r.enabled),
  };
}

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
