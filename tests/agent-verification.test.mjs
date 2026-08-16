import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-verification-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';

const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const events = await import('../server/native/events.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');

const ownerId = 'verification@example.com';
const providerId = 'test_openai';
store.createUser(ownerId, 'hash');
providerConfigs.upsertProviderConfig(ownerId, {
  id: providerId,
  name: 'Verification OpenAI',
  protocol: 'openai',
  baseURL: 'https://api.example.com/v1',
  enabled: true,
});
store.setProviderKey(ownerId, providerId, 'sk-verification-test');

function sse(items) {
  return new Response(items.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('runtime auto-approves tool calls and still forces executable verification after a workspace edit', async () => {
  agent.resetAgentStateForTests();
  events.resetEventsForTests();
  const sid = 'ses_verificationgate1';
  store.createChat(sid, ownerId, 'Новый чат');
  const original = globalThis.fetch;
  let streamCall = 0;
  let sawCompletionGate = false;
  const permissionEvents = [];
  const unsubscribe = events.subscribe(sid, (frame) => {
    if (frame.event?.type === 'permission.asked') permissionEvents.push(frame.event.properties);
  });

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    streamCall += 1;

    if (streamCall === 1) {
      const args = JSON.stringify({ path: 'hello.mjs', content: 'export const ok = true;\n' });
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_write', function: { name: 'write', arguments: args } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }

    if (streamCall === 2) {
      return sse([
        { choices: [{ delta: { content: 'Готово без проверки.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }

    if (streamCall === 3) {
      const lastUser = [...body.messages].reverse().find((message) => message.role === 'user');
      sawCompletionGate = /Runtime completion gate/.test(String(lastUser?.content || ''));
      const args = JSON.stringify({ command: 'node --check hello.mjs' });
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_verify', function: { name: 'bash', arguments: args } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }

    return sse([
      { choices: [{ delta: { content: 'Проверено.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };

  try {
    const assistant = await agent.runTurn({
      sessionId: sid,
      ownerId,
      parts: [{ type: 'text', text: 'Создай корректный модуль hello.mjs' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });

    assert.deepEqual(permissionEvents, []);
    assert.equal(sawCompletionGate, true);
    assert.equal(streamCall, 4);
    assert.equal(assistant.info.strategy?.changed, true);
    assert.equal(assistant.info.strategy?.verificationAttempts, 1);
    assert.equal(assistant.info.strategy?.lastVerificationOk, true);
    assert.equal(fs.readFileSync(path.join(store.workspaceFor(sid), 'hello.mjs'), 'utf8'), 'export const ok = true;\n');
  } finally {
    unsubscribe();
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
    events.resetEventsForTests();
  }
});
