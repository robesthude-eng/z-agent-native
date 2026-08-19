import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-chaos-'));
// Root-run CI uses the UID sandbox for shell/test tools. Allow that sandboxed
// UID to traverse the temporary parent without weakening workspace ownership.
fs.chmodSync(root, 0o755);
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ENABLE_FIXTURE_PROVIDER = '1';
// GitHub-hosted CI is root and uses per-session UIDs. Local/non-root runners
// cannot isolate, so allow the fixture run_tests path instead of looping.
if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const child = path.join(projectRoot, 'tests/fixtures/durable-crash-child.mjs');
const store = await import('../server/native/store.mjs');
const durable = await import('../server/native/durable-jobs.mjs');
const agent = await import('../server/native/agent.mjs');

function crashAt(phase) {
  const result = spawnSync(process.execPath, [child, phase], {
    cwd: projectRoot,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.signal, 'SIGKILL', `child should die abruptly at ${phase}; stderr=${result.stderr}`);
  return `ses_chaos${phase.replace(/[^A-Za-z0-9]/g, '')}1`;
}

async function waitFor(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timeout');
}

test('SIGKILL after an after_tool checkpoint resumes and completes without replaying the completed write', async () => {
  const sid = crashAt('after_tool');
  const job = durable.getDurableJob(sid);
  assert.equal(job?.checkpoint?.phase, 'after_tool');
  assert.equal(job?.checkpoint?.strategy?.needsVerification, true);
  const marker = path.join(store.workspaceFor(sid), 'already.txt');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');

  assert.equal(agent.startDurableRecovery(), 1);
  await waitFor(() => !durable.getDurableJob(sid));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
  assert.equal(store.getAction(sid, 'act_chaos_aftertool')?.state, 'completed');
  const assistant = store.listMessages(sid).find((message) => message.role === 'assistant');
  assert.equal(assistant?.parts.filter((part) => part.id === 'part_existing_write').length, 1);
  assert.match(assistant?.parts.filter((part) => part.type === 'text').at(-1)?.text || '', /Fixture task completed/i);
});

test('SIGKILL after final message persistence repairs finalizing bookkeeping without another model call', async () => {
  const sid = crashAt('finalizing');
  assert.equal(durable.getDurableJob(sid)?.state, 'finalizing');
  const before = store.listMessages(sid);
  assert.equal(before.length, 2);
  assert.equal(agent.startDurableRecovery(), 0);
  await waitFor(() => !durable.getDurableJob(sid));
  const after = store.listMessages(sid);
  assert.equal(after.length, 2);
  assert.equal(after[1].parts.filter((part) => part.type === 'text').length, 1);
  assert.equal(store.getAction(sid, 'act_chaos_finalizing')?.state, 'completed');
});

test.after(() => agent.resetAgentStateForTests());
