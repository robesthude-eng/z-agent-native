import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-tool-stream-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const { interruptedToolParts } = await import('../server/native/agent/recovery.mjs');

const ownerId = 'toolstream@example.com';
store.createUser(ownerId, 'hash');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('after a restart a queued or still-streaming card is not reported as a possible partial action', () => {
  store.createChat('ses_restart1', ownerId, 'Restart');
  const assistant = { id: 'msg_restart1', role: 'assistant', info: {}, time: { created: Date.now() }, sessionID: 'ses_restart1', parts: [
    { id: '1', type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'pending', input: { command: 'rm -rf x' } } },
    { id: '2', type: 'tool', tool: 'write', callID: 'c2', state: { status: 'running', input: {}, metadata: { streamingArgs: true } } },
    { id: '3', type: 'tool', tool: 'bash', callID: 'c3', state: { status: 'running', input: { command: 'rm -rf y' } } },
  ] };
  const ambiguous = interruptedToolParts(assistant);
  assert.equal(ambiguous.length, 1);
  assert.ok(assistant.parts.every((p) => p.state.status === 'error'));
  assert.equal(assistant.parts[0].state.metadata.restartAmbiguous, false);
  assert.equal(assistant.parts[2].state.metadata.restartAmbiguous, true);
});

