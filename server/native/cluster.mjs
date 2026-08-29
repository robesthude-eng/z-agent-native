import { randomUUID } from 'node:crypto';
import { db } from './store/db.mjs';

// Cross-instance coordination.
//
// Every piece of realtime state used to live in one process: the SSE ring
// buffer in events.mjs and the active-turn maps in agent.mjs. That is fine for
// one container and silently wrong with two. A browser attached to replica B
// never sees events emitted on replica A, and both replicas will happily start
// the same turn for the same chat.
//
// Coordination lives in the SQLite database that already holds every durable
// record, so running a second replica needs no new infrastructure. The module
// is inert unless Z_AGENT_CLUSTER is enabled, so the default single node
// deployment keeps its in-process fast path and its current behaviour.

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

export const CLUSTER_ENABLED = flag(process.env.Z_AGENT_CLUSTER);
export const INSTANCE_ID = String(process.env.Z_AGENT_INSTANCE_ID || `node-${randomUUID().slice(0, 8)}`);
export const LOCK_TTL_MS = clamp(process.env.Z_AGENT_CLUSTER_LOCK_TTL_MS, 2_000, 1_800_000, 120_000);
const POLL_MS = clamp(process.env.Z_AGENT_CLUSTER_POLL_MS, 50, 60_000, 250);
const HEARTBEAT_MS = Math.max(1_000, Math.floor(LOCK_TTL_MS / 3));
// Events are a catch-up channel between replicas, not history. The ring buffer
// in events.mjs stays the source of truth for reconnecting clients.
const EVENT_RETENTION_MS = 120_000;

let schemaReady = false;
let cursor = 0;
let poller = null;
let heartbeat = null;
let ingestFrame = null;

function connect() {
  if (schemaReady) return db;
  // Coordination shares the store's single connection to the database file.
  // A second DatabaseSync on the same path was a second connection with its own
  // lock and transaction state, so a cluster write could block or fail the
  // store's writer with SQLITE_BUSY instead of being serialised in-process.
  // Journal mode and busy_timeout are properties of that shared handle and are
  // already configured by the store.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_instances (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cluster_locks (
      key TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      owner TEXT,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cluster_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cluster_events_created ON cluster_events (created_at);
  `);
  schemaReady = true;
  return db;
}

export function isClustered() {
  return CLUSTER_ENABLED;
}

function registerInstance(at) {
  connect()
    .prepare('INSERT INTO cluster_instances (id, started_at, seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at')
    .run(INSTANCE_ID, at, at);
}

// Registers this replica and starts consuming what the others publish.
// Safe to call repeatedly; only the first call installs the timers.
export function startCluster({ ingest } = {}) {
  if (!CLUSTER_ENABLED) return false;
  if (ingest) ingestFrame = ingest;
  if (poller) return true;
  const now = Date.now();
  registerInstance(now);
  // Start at the current tip. Events older than this process were already
  // delivered to whoever was connected at the time.
  cursor = Number(connect().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM cluster_events').get().seq) || 0;
  poller = setInterval(() => {
    try { pollClusterEvents(); } catch { /* a transient sqlite error must not kill the process */ }
  }, POLL_MS);
  poller.unref?.();
  heartbeat = setInterval(() => {
    try { touchInstance(); } catch { /* ditto */ }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  return true;
}

export function stopCluster() {
  if (poller) clearInterval(poller);
  if (heartbeat) clearInterval(heartbeat);
  poller = null;
  heartbeat = null;
  ingestFrame = null;
  cursor = 0;
  // The handle belongs to the store and stays open for the rest of the process;
  // stopping coordination must not close the database out from under it.
}

export function touchInstance(at = Date.now()) {
  if (!CLUSTER_ENABLED) return;
  registerInstance(at);
}

export function listInstances(now = Date.now()) {
  if (!CLUSTER_ENABLED) return [{ id: INSTANCE_ID, startedAt: now, seenAt: now, self: true, alive: true }];
  return connect()
    .prepare('SELECT id, started_at, seen_at FROM cluster_instances ORDER BY started_at')
    .all()
    .map((row) => ({
      id: row.id,
      startedAt: Number(row.started_at),
      seenAt: Number(row.seen_at),
      self: row.id === INSTANCE_ID,
      alive: now - Number(row.seen_at) <= LOCK_TTL_MS,
    }));
}

// `instanceId` is explicit so tests and recovery tooling can act on behalf of
// another replica; normal callers use the default.
export function publishEvent(sessionId, event, instanceId = INSTANCE_ID) {
  if (!CLUSTER_ENABLED) return 0;
  const row = connect()
    .prepare('INSERT INTO cluster_events (session_id, instance_id, created_at, payload) VALUES (?, ?, ?, ?) RETURNING seq')
    .get(sessionId, instanceId, Date.now(), JSON.stringify(event));
  return Number(row?.seq) || 0;
}

// Drains events published by the other replicas and returns how many frames
// were handed to local subscribers.
export function pollClusterEvents() {
  if (!CLUSTER_ENABLED || !ingestFrame) return 0;
  const rows = connect()
    .prepare('SELECT seq, session_id, instance_id, payload FROM cluster_events WHERE seq > ? ORDER BY seq LIMIT 500')
    .all(cursor);
  let delivered = 0;
  for (const row of rows) {
    cursor = Math.max(cursor, Number(row.seq) || 0);
    // Our own writes were already delivered in-process by emit().
    if (row.instance_id === INSTANCE_ID) continue;
    let event = null;
    try { event = JSON.parse(row.payload); } catch { continue; }
    try { ingestFrame(row.session_id, event); delivered += 1; } catch { /* subscriber owns its socket */ }
  }
  if (rows.length) pruneEvents();
  return delivered;
}

export function pruneEvents(before = Date.now() - EVENT_RETENTION_MS) {
  if (!CLUSTER_ENABLED) return 0;
  const info = connect().prepare('DELETE FROM cluster_events WHERE created_at < ?').run(before);
  return Number(info?.changes) || 0;
}

// Single-owner lock with TTL takeover. A replica that dies mid-turn stops
// renewing, and once the TTL passes another replica may recover the work
// instead of leaving that chat wedged forever.
export function acquireLock(key, options = {}) {
  const { ttlMs = LOCK_TTL_MS, owner = null, now = Date.now(), instanceId = INSTANCE_ID } = options;
  if (!CLUSTER_ENABLED) return { ok: true, instanceId, owner, expiresAt: now + ttlMs, takeover: false };
  const handle = connect();
  // The guarded upsert below is atomic per statement, but the surrounding
  // read-decide-write was not: between the first SELECT and the INSERT another
  // replica could take the lock, and the early return would then report a
  // holder that no longer exists. BEGIN IMMEDIATE takes the write lock up front
  // so the whole decision is serialised; busy_timeout makes the loser wait
  // instead of failing with SQLITE_BUSY.
  handle.exec('BEGIN IMMEDIATE');
  try {
    const current = handle.prepare('SELECT instance_id, owner, expires_at FROM cluster_locks WHERE key=?').get(key);
    const expired = current ? Number(current.expires_at) <= now : false;
    if (current && !expired && current.instance_id !== instanceId) {
      handle.exec('COMMIT');
      return { ok: false, instanceId: current.instance_id, owner: current.owner ?? null, expiresAt: Number(current.expires_at), takeover: false };
    }
    // Two replicas racing for an expired lock both run this, and only one row
    // survives.
    handle
      .prepare('INSERT INTO cluster_locks (key, instance_id, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET instance_id=excluded.instance_id, owner=excluded.owner, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at WHERE cluster_locks.expires_at <= ? OR cluster_locks.instance_id = ?')
      .run(key, instanceId, owner, now, now + ttlMs, now, instanceId);
    const after = handle.prepare('SELECT instance_id, owner, expires_at FROM cluster_locks WHERE key=?').get(key);
    handle.exec('COMMIT');
    const ok = after?.instance_id === instanceId;
    return { ok, instanceId: after?.instance_id ?? null, owner: after?.owner ?? null, expiresAt: Number(after?.expires_at) || 0, takeover: ok && expired };
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function renewLock(key, options = {}) {
  const { ttlMs = LOCK_TTL_MS, now = Date.now(), instanceId = INSTANCE_ID } = options;
  if (!CLUSTER_ENABLED) return true;
  const info = connect().prepare('UPDATE cluster_locks SET expires_at=? WHERE key=? AND instance_id=?').run(now + ttlMs, key, instanceId);
  return (Number(info?.changes) || 0) > 0;
}

export function releaseLock(key, options = {}) {
  const { instanceId = INSTANCE_ID } = options;
  if (!CLUSTER_ENABLED) return true;
  const info = connect().prepare('DELETE FROM cluster_locks WHERE key=? AND instance_id=?').run(key, instanceId);
  return (Number(info?.changes) || 0) > 0;
}

export function lockHolder(key) {
  if (!CLUSTER_ENABLED) return null;
  const row = connect().prepare('SELECT instance_id, owner, acquired_at, expires_at FROM cluster_locks WHERE key=?').get(key);
  if (!row) return null;
  return { instanceId: row.instance_id, owner: row.owner ?? null, acquiredAt: Number(row.acquired_at), expiresAt: Number(row.expires_at) };
}

export const turnLockKey = (sessionId) => `turn:${sessionId}`;

export function acquireTurnLock(sessionId, options = {}) {
  return acquireLock(turnLockKey(sessionId), options);
}

export function renewTurnLock(sessionId, options = {}) {
  return renewLock(turnLockKey(sessionId), options);
}

export function releaseTurnLock(sessionId, options = {}) {
  return releaseLock(turnLockKey(sessionId), options);
}

export function turnLockHolder(sessionId) {
  return lockHolder(turnLockKey(sessionId));
}

export function resetClusterForTests() {
  stopCluster();
}

// Adapter interface, for a Redis (or NATS, or Postgres) backend later.
//
//   {
//     start({ ingest }): void        // begin delivering remote events
//     stop(): void
//     publish(sessionId, event): void
//     acquire(key, { ttlMs, owner }): { ok, instanceId, owner, expiresAt, takeover }
//     renew(key, { ttlMs }): boolean
//     release(key): boolean
//     holder(key): { instanceId, owner, acquiredAt, expiresAt } | null
//     instances(): Array<{ id, startedAt, seenAt, self, alive }>
//   }
//
// The SQLite implementation above is the only one shipped: it is the backend
// that is actually deployed, so it is the only one that can be tested here.
// Anything else would be untested guesswork pretending to be support.
