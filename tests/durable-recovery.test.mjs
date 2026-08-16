import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-durable-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const durable = await import('../server/native/durable-jobs.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');
const { shellSandboxAvailable } = await import('../server/native/sandbox.mjs');

const ownerId = 'durable@example.com';
const providerId = 'openai';
store.createUser(ownerId, 'hash');
providerConfigs.upsertProviderConfig(ownerId, {
  id: providerId,
  name: 'Durable Test Provider',
  protocol: 'openai',
  baseURL: 'https://1.1.1.1/v1',
  enabled: true,
});
store.setProviderKey(ownerId, providerId, 'sk-durable-test');

function sse(events) {
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function finalSse(text) {
  return sse([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]);
}

function toolSse(id, name, args) {
  return sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
}

async function waitFor(fn, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timeout');
}

function seedMessages(sid, assistantParts) {
  const userId = `msg_user${sid.slice(4)}`;
  const assistantId = `msg_assistant${sid.slice(4)}`;
  store.putMessage({
    id: userId,
    role: 'user',
    sessionID: sid,
    parts: [{ type: 'text', text: 'Продолжи задачу после рестарта' }],
    time: { created: Date.now() - 2000, completed: Date.now() - 2000 },
    info: { role: 'user', finish: 'stop', time: { created: Date.now() - 2000, completed: Date.now() - 2000 } },
  });
  store.putMessage({
    id: assistantId,
    role: 'assistant',
    sessionID: sid,
    parts: assistantParts,
    time: { created: Date.now() - 1500 },
    info: { role: 'assistant', time: { created: Date.now() - 1500 } },
  });
  return { userId, assistantId };
}

function seedJob({ sid, actionId, turnId, userId, assistantId }) {
  store.setTurn(sid, { turnId, lifecycle: 'running', verdict: null, reason: 'tool', since: Date.now() - 1000 });
  store.claimAction(sid, actionId);
  durable.createDurableJob({
    sessionId: sid,
    ownerId,
    actionId,
    turnId,
    userMessageId: userId,
    assistantMessageId: assistantId,
    requestedModel: { providerID: providerId, modelID: 'gpt-durable' },
    goal: 'Продолжи задачу после рестарта',
    stepBudget: 12,
  });
  store.recoverInterruptedRuntimeState();
}

test('durable checkpoint is atomic and an unfinished job cannot be overwritten', () => {
  durable.resetDurableJobsForTests();
  const sid = 'ses_durableatomic1';
  store.createChat(sid, ownerId, 'Atomic');
  const first = durable.createDurableJob({
    sessionId: sid,
    ownerId,
    actionId: 'act_atomic1',
    turnId: 'turn_atomic1',
    userMessageId: 'msg_atomicuser1',
    assistantMessageId: 'msg_atomicassistant1',
    requestedModel: { providerID: providerId, modelID: 'gpt-durable' },
    goal: 'atomic checkpoint',
    stepBudget: 52,
  });
  assert.equal(first.state, 'running');
  durable.checkpointDurableJob(sid, { phase: 'after_tool', stepsUsed: 3, recoveryInspected: false }, {
    modelPlan: { candidates: [{ providerID: providerId, modelID: 'gpt-durable' }], explicit: true },
  });
  const saved = durable.getDurableJob(sid);
  assert.equal(saved.checkpoint.stepsUsed, 3);
  assert.equal(saved.modelPlan.candidates[0].modelID, 'gpt-durable');
  assert.throws(() => durable.createDurableJob({ sessionId: sid, ownerId }), /unfinished durable turn/i);
  durable.clearDurableJob(sid);
});

test('restart resumes the same assistant and does not replay a completed side-effect tool', async () => {
  durable.resetDurableJobsForTests();
  agent.resetAgentStateForTests();
  const sid = 'ses_durablecomplete1';
  const actionId = 'act_durablecomplete1';
  const turnId = 'turn_durablecomplete1';
  store.createChat(sid, ownerId, 'Completed checkpoint');
  const { userId, assistantId } = seedMessages(sid, [{
    id: 'part_env_done',
    type: 'tool',
    tool: 'ensure_environment',
    callID: 'call_env_done',
    state: {
      status: 'completed',
      input: { kind: 'python', version: '3.12' },
      output: 'Python environment already provisioned once.',
      metadata: { provisioned: true },
      time: { start: Date.now() - 1200, end: Date.now() - 1100 },
    },
  }]);
  seedJob({ sid, actionId, turnId, userId, assistantId });

  const original = globalThis.fetch;
  let providerCalls = 0;
  let sawCompletedToolResult = false;
  globalThis.fetch = async (_url, init) => {
    providerCalls += 1;
    const body = JSON.parse(init.body);
    const serialized = JSON.stringify(body.messages || []);
    sawCompletedToolResult ||= serialized.includes('Python environment already provisioned once.');
    return finalSse('Продолжил с сохранённого checkpoint без повторной установки.');
  };

  try {
    assert.equal(agent.startDurableRecovery(), 1);
    await waitFor(() => !durable.getDurableJob(sid));
    const action = store.getAction(sid, actionId);
    assert.equal(action?.state, 'completed');
    assert.equal(providerCalls, 1);
    assert.equal(sawCompletedToolResult, true);
    const messages = store.listMessages(sid);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].id, assistantId);
    assert.equal(messages[1].parts.filter((part) => part.tool === 'ensure_environment').length, 1);
    assert.match(messages[1].parts.find((part) => part.type === 'text')?.text || '', /checkpoint/);
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('an identical mutating call interrupted by restart is blocked until state inspection', async () => {
  durable.resetDurableJobsForTests();
  agent.resetAgentStateForTests();
  const sid = 'ses_durableambiguous1';
  const actionId = 'act_durableambiguous1';
  const turnId = 'turn_durableambiguous1';
  store.createChat(sid, ownerId, 'Ambiguous checkpoint');
  const workspace = store.workspaceFor(sid);
  fs.writeFileSync(path.join(workspace, 'marker.txt'), 'once\n');
  fs.writeFileSync(path.join(workspace, 'check.js'), 'const value = 1;\n');
  const command = "printf 'once\\n' >> marker.txt";
  const { userId, assistantId } = seedMessages(sid, [{
    id: 'part_bash_running',
    type: 'tool',
    tool: 'bash',
    callID: 'call_bash_running',
    state: {
      status: 'running',
      input: { command },
      output: '',
      time: { start: Date.now() - 1200 },
    },
  }]);
  seedJob({ sid, actionId, turnId, userId, assistantId });

  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 1) return toolSse('call_repeat_bash', 'bash', { command });
    if (providerCalls === 2) return toolSse('call_inspect', 'read', { path: 'marker.txt', offset: 0, limit: 20 });
    if (shellSandboxAvailable() && providerCalls === 3) return toolSse('call_verify', 'bash', { command: 'node --check check.js' });
    return finalSse('Состояние после рестарта проверено; опасный повтор не выполнялся автоматически.');
  };

  try {
    assert.equal(agent.startDurableRecovery(), 1);
    await waitFor(() => !durable.getDurableJob(sid), 6000);
    assert.equal(fs.readFileSync(path.join(workspace, 'marker.txt'), 'utf8'), 'once\n');
    const assistant = store.listMessages(sid).find((message) => message.id === assistantId);
    const interrupted = assistant.parts.find((part) => part.id === 'part_bash_running');
    assert.equal(interrupted.state.status, 'error');
    assert.equal(interrupted.state.metadata.restartAmbiguous, true);
    const blocked = assistant.parts.find((part) => part.state?.metadata?.restartGuardBlocked);
    assert.ok(blocked, 'identical post-restart mutating call should be blocked');
    const inspection = assistant.parts.find((part) => part.tool === 'read' && part.state?.status === 'completed');
    assert.ok(inspection, 'agent must inspect state before any equivalent mutation may be allowed');
    assert.equal(store.getAction(sid, actionId)?.state, 'completed');
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});
