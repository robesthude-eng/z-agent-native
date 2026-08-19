/**
 * Forward-only, idempotent SQLite schema migrations.
 *
 * Rules:
 * - Existing migrations are immutable once released.
 * - Migrations must remain backward-compatible with the immediately previous
 *   application schema whenever their schema_compatibility marker says so.
 * - Older code NEVER rewrites a newer PRAGMA user_version downward. A future
 *   release can explicitly advertise that an older reader remains compatible
 *   by setting schema_compatibility.min_reader_version.
 * - Destructive rebuilds require a separate maintenance release and backup.
 */
export const MIGRATIONS = [
  {
    version: 1,
    id: '20260820_001_chat_sandbox_uid',
    // Additive migration: schema reader v1 remains safe against this shape.
    minReaderVersion: 1,
    up(db) {
      const columns = db.prepare('PRAGMA table_info(chats)').all();
      if (!columns.some((column) => column.name === 'sandbox_uid')) db.exec('ALTER TABLE chats ADD COLUMN sandbox_uid INTEGER');
    },
  },
  {
    version: 2,
    id: '20260820_002_auth_session_csrf',
    // Additive migration: schema reader v1 remains safe against this shape.
    minReaderVersion: 1,
    up(db) {
      const columns = db.prepare('PRAGMA table_info(auth_sessions)').all();
      if (!columns.some((column) => column.name === 'csrf')) db.exec('ALTER TABLE auth_sessions ADD COLUMN csrf TEXT');
    },
  },
  {
    version: 3,
    id: '20260820_003_runtime_indexes',
    // Additive migration: schema reader v1 remains safe against this shape.
    minReaderVersion: 1,
    up(db) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_sandbox_uid ON chats(sandbox_uid);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_email ON auth_sessions(email);
        CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_questions_session_status ON questions(session_id, status);
        CREATE INDEX IF NOT EXISTS idx_permissions_session_status ON permissions(session_id, status);
      `);
    },
  },
  {
    version: 4,
    id: '20260820_004_shared_auth_rate_limits',
    // Additive migration: schema reader v1 remains safe against this shape.
    minReaderVersion: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_rate_limits (
          bucket TEXT PRIMARY KEY,
          failures INTEGER NOT NULL,
          reset_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_reset ON auth_rate_limits(reset_at);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version || 0;
// Oldest schema-aware runtime that can safely operate after *all* migrations
// in this release. A destructive/incompatible migration must raise its own
// minReaderVersion. Deploy compares this value to the running release before
// allowing a candidate to start, preserving a safe application rollback path.
export const SCHEMA_MIN_READER_VERSION = MIGRATIONS.reduce((minimum, migration) => {
  const required = Number(migration.minReaderVersion ?? migration.version);
  if (!Number.isInteger(required) || required < 1 || required > migration.version) {
    throw new Error(`Migration ${migration.id} has invalid minReaderVersion ${migration.minReaderVersion}`);
  }
  return Math.max(minimum, required);
}, 1);

function ensureMigrationMetadata(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_compatibility (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      current_version INTEGER NOT NULL,
      min_reader_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function appliedVersion(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version || 0);
}

/**
 * Inspect whether this application version may safely operate on the current
 * database. Future migrations that remain backward-compatible can advertise
 * that fact without requiring the older binary to know the future migration ID.
 */
export function inspectSchemaCompatibility(db) {
  ensureMigrationMetadata(db);
  const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  const recordedVersion = appliedVersion(db);
  const currentVersion = Math.max(userVersion, recordedVersion);
  const marker = db.prepare('SELECT current_version,min_reader_version FROM schema_compatibility WHERE singleton=1').get() || null;

  if (currentVersion <= LATEST_SCHEMA_VERSION) {
    return {
      compatible: currentVersion === LATEST_SCHEMA_VERSION,
      currentVersion,
      codeVersion: LATEST_SCHEMA_VERSION,
      minReaderVersion: marker ? Number(marker.min_reader_version) : LATEST_SCHEMA_VERSION,
      newerCompatible: false,
    };
  }

  const markerCurrent = Number(marker?.current_version || 0);
  const minReaderVersion = Number(marker?.min_reader_version || Number.MAX_SAFE_INTEGER);
  const compatible = markerCurrent === currentVersion && minReaderVersion <= LATEST_SCHEMA_VERSION;
  return { compatible, currentVersion, codeVersion: LATEST_SCHEMA_VERSION, minReaderVersion, newerCompatible: compatible };
}

export function runMigrations(db) {
  ensureMigrationMetadata(db);
  const appliedRows = db.prepare('SELECT version,id FROM schema_migrations ORDER BY version').all();
  const applied = new Map(appliedRows.map((row) => [Number(row.version), String(row.id)]));

  // A database from a future release must never be silently relabelled as an
  // older schema. Only an explicit compatibility marker written by that future
  // release allows this binary to run against it.
  const before = inspectSchemaCompatibility(db);
  if (before.currentVersion > LATEST_SCHEMA_VERSION) {
    if (!before.compatible) {
      throw new Error(`Database schema ${before.currentVersion} is newer than code schema ${LATEST_SCHEMA_VERSION} and does not advertise backward compatibility`);
    }
    return { version: before.currentVersion, codeVersion: LATEST_SCHEMA_VERSION, applied: appliedRows.length, newerCompatible: true, minReaderVersion: before.minReaderVersion };
  }

  for (const migration of MIGRATIONS) {
    const existing = applied.get(migration.version);
    if (existing && existing !== migration.id) throw new Error(`Schema migration ${migration.version} identity mismatch: database=${existing}, code=${migration.id}`);
    if (existing) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version,id,applied_at) VALUES(?,?,?)').run(migration.version, migration.id, Date.now());
      db.exec(`PRAGMA user_version=${migration.version}`);
      db.exec('COMMIT');
      applied.set(migration.version, migration.id);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw new Error(`Migration ${migration.id} failed: ${error?.message || error}`, { cause: error });
    }
  }

  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (version < LATEST_SCHEMA_VERSION) db.exec(`PRAGMA user_version=${LATEST_SCHEMA_VERSION}`);
  const finalVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (finalVersion !== LATEST_SCHEMA_VERSION) throw new Error(`Unexpected schema version ${finalVersion}; expected ${LATEST_SCHEMA_VERSION}`);
  db.prepare(`
    INSERT INTO schema_compatibility(singleton,current_version,min_reader_version,updated_at)
    VALUES(1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET
      current_version=excluded.current_version,
      min_reader_version=excluded.min_reader_version,
      updated_at=excluded.updated_at
  `).run(LATEST_SCHEMA_VERSION, SCHEMA_MIN_READER_VERSION, Date.now());
  return { version: LATEST_SCHEMA_VERSION, codeVersion: LATEST_SCHEMA_VERSION, applied: applied.size, newerCompatible: false, minReaderVersion: SCHEMA_MIN_READER_VERSION };
}
