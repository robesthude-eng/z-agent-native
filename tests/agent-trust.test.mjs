import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-trust-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');

const ownerId = 'trust@example.com';
const providerId = 'openai';
store.createUser(ownerId, 'hash');
providerConfigs.upsertProviderConfig(ownerId, {
  id: providerId,
  name: 'Trust Test OpenAI',
  protocol: 'openai',
  baseURL: 'https://1.1.1.1/v1',
  enabled: true,
});
store.setProviderKey(ownerId, providerId, 'sk-trust-test');

function sse(events) {
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolStream(index, name, args) {
  return sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}_${index}`, function: { name, arguments: JSON.stringify(args) } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
}

test('repeated identical tool observations stop the turn before the global step limit', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_trustloop1';
  store.createChat(sid, ownerId, 'Новый чат');
  const workspace = store.workspaceFor(sid);
  fs.writeFileSync(path.join(workspace, 'same.txt'), 'unchanged\n');

  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return toolStream(providerCalls, 'read', { path: 'same.txt' });
  };

  try {
    const assistant = await agent.submitTurn({
      sessionId: sid,
      ownerId,
      actionId: 'act_loop_guard',
      parts: [{ type: 'text', text: 'Проверь файл' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });

    const reads = assistant.parts.filter((part) => part.type === 'tool' && part.tool === 'read');
    assert.equal(reads.length, 3);
    assert.equal(providerCalls, 3);
    assert.equal(assistant.info?.outcome?.status, 'partial');
    assert.equal(assistant.info?.outcome?.label, 'Частично выполнено');
    assert.match(assistant.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n'), /повторил одно и то же действие/i);

    const repeated = await agent.submitTurn({
      sessionId: sid,
      ownerId,
      actionId: 'act_loop_guard',
      parts: [{ type: 'text', text: 'Проверь файл' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });
    assert.equal(repeated.id, assistant.id);
    assert.equal(providerCalls, 3, 'same action id must not restart a guarded turn');
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('a transient webfetch failure is retried once inside the same tool call', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_trustretry1';
  store.createChat(sid, ownerId, 'Новый чат');

  const original = globalThis.fetch;
  const { setExternalTransportForTests } = await import('../server/native/security.mjs');
  // webfetch no longer uses global fetch: it goes through the SSRF-validated,
  // address-pinned transport. Point that transport back at the stub below.
  setExternalTransportForTests(async ({ url }) => {
    const res = await globalThis.fetch(String(url));
    return { url, status: res.status, headers: {}, text: await res.text(), truncated: false };
  });
  let providerCalls = 0;
  let webCalls = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('1.1.1.1/data')) {
      webCalls += 1;
      if (webCalls === 1) throw new TypeError('fetch failed');
      return new Response('network recovered', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    providerCalls += 1;
    if (providerCalls === 1) return toolStream(1, 'webfetch', { url: 'https://1.1.1.1/data' });
    return sse([
      { choices: [{ delta: { content: 'Данные получены после восстановления сети.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };

  try {
    const assistant = await agent.runTurn({
      sessionId: sid,
      ownerId,
      parts: [{ type: 'text', text: 'Получи данные' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });

    const fetchPart = assistant.parts.find((part) => part.type === 'tool' && part.tool === 'webfetch');
    assert.equal(webCalls, 2);
    assert.equal(providerCalls, 2);
    assert.equal(fetchPart?.state?.status, 'completed');
    assert.equal(fetchPart?.state?.metadata?.retryCount, 1);
    assert.equal(assistant.info?.outcome?.status, 'completed');
  } finally {
    setExternalTransportForTests(null);
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});
