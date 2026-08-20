import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('versioned migration runner records immutable schema history', async () => {
  const { runMigrations, LATEST_SCHEMA_VERSION, SCHEMA_MIN_READER_VERSION } = await import('../server/native/migrations.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chats(id TEXT PRIMARY KEY, owner_id TEXT, title TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE auth_sessions(token TEXT PRIMARY KEY, email TEXT, created_at INTEGER);
    CREATE TABLE messages(id TEXT, session_id TEXT, created_at INTEGER);
    CREATE TABLE questions(id TEXT, session_id TEXT, status TEXT);
    CREATE TABLE permissions(id TEXT, session_id TEXT, status TEXT);
  `);
  const first = runMigrations(db);
  const second = runMigrations(db);
  assert.equal(first.version, LATEST_SCHEMA_VERSION);
  assert.equal(second.version, LATEST_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, LATEST_SCHEMA_VERSION);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT min_reader_version FROM schema_compatibility WHERE singleton=1').get().min_reader_version, SCHEMA_MIN_READER_VERSION);
  assert.ok(db.prepare('PRAGMA table_info(chats)').all().some((column) => column.name === 'sandbox_uid'));
  assert.ok(db.prepare('PRAGMA table_info(auth_sessions)').all().some((column) => column.name === 'csrf'));
  db.close();
});

test('migration runner never downgrades a newer schema and only accepts an explicit compatibility marker', async () => {
  const { runMigrations, LATEST_SCHEMA_VERSION } = await import('../server/native/migrations.mjs');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chats(id TEXT PRIMARY KEY, owner_id TEXT, title TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE auth_sessions(token TEXT PRIMARY KEY, email TEXT, created_at INTEGER);
    CREATE TABLE messages(id TEXT, session_id TEXT, created_at INTEGER);
    CREATE TABLE questions(id TEXT, session_id TEXT, status TEXT);
    CREATE TABLE permissions(id TEXT, session_id TEXT, status TEXT);
  `);
  runMigrations(db);
  const future = LATEST_SCHEMA_VERSION + 1;
  db.prepare('INSERT INTO schema_migrations(version,id,applied_at) VALUES(?,?,?)').run(future, 'future_compatible_migration', Date.now());
  db.exec(`PRAGMA user_version=${future}`);
  db.prepare('UPDATE schema_compatibility SET current_version=?,min_reader_version=?,updated_at=? WHERE singleton=1')
    .run(future, LATEST_SCHEMA_VERSION, Date.now());
  const compatible = runMigrations(db);
  assert.equal(compatible.version, future);
  assert.equal(compatible.newerCompatible, true);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, future);

  db.prepare('UPDATE schema_compatibility SET min_reader_version=?,updated_at=? WHERE singleton=1').run(future, Date.now());
  assert.throws(() => runMigrations(db), /newer than code schema.*does not advertise backward compatibility/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, future);
  db.close();
});

test('online backup script creates a standalone integrity-checked SQLite snapshot', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-backup-test-'));
  const dbPath = path.join(temp, 'z-agent.sqlite');
  const backupPath = path.join(temp, 'backups', 'snapshot.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE demo(value TEXT); INSERT INTO demo VALUES (\'durable\');');
  db.close();
  const stdout = execFileSync(process.execPath, [path.join(repoRoot, 'server/backup.mjs'), backupPath], {
    env: { ...process.env, Z_AGENT_DB_PATH: dbPath }, encoding: 'utf8', timeout: 10_000,
  });
  assert.match(stdout, /"ok":true/);
  const verify = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(verify.prepare('SELECT value FROM demo').get().value, 'durable');
  assert.equal(verify.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  verify.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('backup refuses a missing source database instead of silently creating an empty one', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-backup-missing-'));
  const missing = path.join(temp, 'missing.sqlite');
  const backupPath = path.join(temp, 'backup.sqlite');
  assert.throws(() => execFileSync(process.execPath, [path.join(repoRoot, 'server/backup.mjs'), backupPath], {
    env: { ...process.env, Z_AGENT_DB_PATH: missing }, encoding: 'utf8', timeout: 10_000, stdio: 'pipe',
  }), /Source database does not exist/);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.existsSync(backupPath), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('Prometheus output uses low-cardinality operational labels only', async () => {
  const metrics = await import('../server/native/metrics.mjs');
  metrics.resetMetricsForTests();
  metrics.observeTurnSummary({
    outcome: 'completed', modelCalls: 2, fallbackAttempts: 1, toolCalls: 3, toolErrors: 1, toolRetries: 2,
    tokens: { input: 100, output: 25 }, durationMs: 1500, modelLatencyMs: 800, toolLatencyMs: 500,
    verificationAttempts: 1, gateReminders: 1, tools: { bash: { calls: 2, errors: 1 } },
    sessionId: 'ses_secret_should_not_appear', turnId: 'turn_secret_should_not_appear',
  });
  const text = metrics.prometheusMetrics({ activeTurns: 4 });
  assert.match(text, /z_agent_turns_total\{outcome="completed"\} 1/);
  assert.match(text, /z_agent_active_turns 4/);
  assert.match(text, /z_agent_tool_calls_by_tool_total\{tool="bash"\} 2/);
  assert.doesNotMatch(text, /ses_secret_should_not_appear|turn_secret_should_not_appear/);
});
