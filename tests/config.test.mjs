import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// These modules read configuration when they load, and cluster.mjs now shares
// the store's single SQLite handle, so point the data directory at a scratch
// location before importing anything.
process.env.Z_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'z-config-'));

const {
  DEFAULT_TOOL_TIMEOUT_MS,
  PROVIDER_STREAM_IDLE_MS,
  PROVIDER_STREAM_HARD_MS,
} = await import('../server/native/config.mjs');
const { LOCK_TTL_MS } = await import('../server/native/cluster.mjs');
const { TOOL_DEFINITIONS } = await import('../server/native/tools.mjs');

test('long-session defaults allow a 30-minute turn', () => {
  assert.equal(DEFAULT_TOOL_TIMEOUT_MS, 600_000);
  assert.equal(PROVIDER_STREAM_IDLE_MS, 180_000);
  assert.equal(PROVIDER_STREAM_HARD_MS, 1_800_000);
  assert.equal(LOCK_TTL_MS, 120_000);
  const bash = TOOL_DEFINITIONS.find((tool) => tool.name === 'bash');
  const env = TOOL_DEFINITIONS.find((tool) => tool.name === 'ensure_environment');
  assert.equal(bash.inputSchema.properties.timeoutMs.maximum, 1_800_000);
  assert.equal(env.inputSchema.properties.timeoutMs.maximum, 1_800_000);
});
