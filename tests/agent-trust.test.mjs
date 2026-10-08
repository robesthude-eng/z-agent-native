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
const providers = await import('../server/native/providers.mjs');
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
providers.setProviderTransportForTests((url, init) => globalThis.fetch(url, init));

function sse(events) {
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolStream(index, name, args) {
  return sse([
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: `call_${name}_${index}`, function: { name, arguments: JSON.stringify(args) } }] } },
      ],
    },
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
    // Первое срабатывание защиты — предупреждение модели, второе — остановка.
    assert.equal(reads.length, 6);
    assert.equal(providerCalls, 6);
    assert.equal(assistant.info?.outcome?.status, 'partial');
    assert.equal(assistant.info?.outcome?.label, 'Частично выполнено');
    assert.match(
      assistant.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      /повторил одно и то же действие/i,
    );

    const repeated = await agent.submitTurn({
      sessionId: sid,
      ownerId,
      actionId: 'act_loop_guard',
      parts: [{ type: 'text', text: 'Проверь файл' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });
    assert.equal(repeated.id, assistant.id);
    assert.equal(providerCalls, 6, 'same action id must not restart a guarded turn');
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('truncated tool arguments are not executed', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_trusttrunc1';
  store.createChat(sid, ownerId, 'Новый чат');
  const workspace = store.workspaceFor(sid);

  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'bash', arguments: '{"command":"printf hacked > PWNED.txt' } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }
    return sse([
      { choices: [{ delta: { content: 'Остановился на обрезанном вызове.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };

  try {
    const assistant = await agent.runTurn({
      sessionId: sid,
      ownerId,
      parts: [{ type: 'text', text: 'Сделай файл' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });
    assert.equal(fs.existsSync(path.join(workspace, 'PWNED.txt')), false);
    const bash = assistant.parts.find((part) => part.type === 'tool' && part.tool === 'bash');
    assert.equal(bash?.state?.status, 'error');
    assert.equal(bash?.state?.metadata?.incompleteArguments, true);
    assert.match(String(bash?.state?.output || ''), /обрезан/i);
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('a transient webfetch failure is retried once inside the same tool call', async () => {
  agent.resetAgentStateForTests();
  const previousNetworkPolicy = process.env.Z_AGENT_NETWORK_POLICY;
  process.env.Z_AGENT_NETWORK_POLICY = 'public';
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
    if (previousNetworkPolicy == null) delete process.env.Z_AGENT_NETWORK_POLICY;
    else process.env.Z_AGENT_NETWORK_POLICY = previousNetworkPolicy;
    agent.resetAgentStateForTests();
  }
});

test.after(() => providers.setProviderTransportForTests(null));

function textStream(text, finish = 'stop') {
  return sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]']);
}

function interruptedTextStream(text) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      setTimeout(() => controller.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 5);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function runTrustTurn(sid, actionId) {
  store.createChat(sid, ownerId, 'Новый чат');
  return agent.submitTurn({
    sessionId: sid,
    ownerId,
    actionId,
    parts: [{ type: 'text', text: 'Сделай задачу' }],
    model: { providerID: providerId, modelID: 'gpt-test' },
    system: '',
  });
}

test('a provider stream cut mid-answer continues the same turn instead of closing it', async () => {
  agent.resetAgentStateForTests();
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 1) return interruptedTextStream('Начинаю работу');
    return textStream('Задача выполнена.');
  };
  try {
    const assistant = await runTrustTurn('ses_trustcut1', 'act_stream_cut');
    assert.equal(providerCalls, 2, 'interrupted stream must be continued, not treated as final');
    const text = assistant.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    assert.match(text, /Задача выполнена/);
    assert.equal(assistant.info?.finish, 'stop');
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('a response cut by the output token limit is continued', async () => {
  agent.resetAgentStateForTests();
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 1) return textStream('Часть ответа', 'length');
    return textStream('Конец ответа.');
  };
  try {
    const assistant = await runTrustTurn('ses_trustlen1', 'act_length_cut');
    assert.equal(providerCalls, 2);
    assert.match(
      assistant.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      /Конец ответа/,
    );
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('a transient provider 5xx between steps is retried inside the turn', async () => {
  agent.resetAgentStateForTests();
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    // Транспорт сам повторяет 5xx; здесь сбой длиннее его бюджета повторов.
    if (providerCalls <= 4)
      return new Response(JSON.stringify({ error: { message: 'upstream internal error' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    return textStream('Готово после сбоя.');
  };
  try {
    const assistant = await runTrustTurn('ses_trust5xx1', 'act_transient_5xx');
    assert.ok(providerCalls >= 5);
    assert.equal(assistant.info?.finish, 'stop');
    assert.match(
      assistant.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      /Готово после сбоя/,
    );
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('the model cannot stop while its own todo plan still has unfinished items', async () => {
  agent.resetAgentStateForTests();
  const original = globalThis.fetch;
  let providerCalls = 0;
  const todos = (status) => ({
    todos: [
      { content: 'Шаг 1', status: 'completed', priority: 'high' },
      { content: 'Шаг 2', status, priority: 'high' },
    ],
  });
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 1) return toolStream(1, 'todowrite', todos('pending'));
    if (providerCalls === 2) return textStream('Сейчас продолжу.');
    if (providerCalls === 3) return toolStream(3, 'todowrite', todos('completed'));
    return textStream('Все пункты выполнены.');
  };
  try {
    const assistant = await runTrustTurn('ses_trustplan1', 'act_plan_gate');
    assert.equal(providerCalls, 4, 'plan gate must push the model to continue once');
    assert.equal(assistant.info?.outcome?.status, 'completed');
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('a provider auth failure is shown once, in plain words, and is not replayed as the assistant reply', async () => {
  agent.resetAgentStateForTests();
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const assistant = await runTrustTurn('ses_trustauth1', 'act_auth_401');
    assert.equal(providerCalls, 1, '401 is not retried');
    assert.equal(assistant.info?.finish, 'error');
    assert.equal(assistant.parts.filter((part) => part.type === 'text').length, 0, 'the banner is the only place the error appears');
    assert.match(assistant.info?.error?.message || '', /отклонил API/i);
    assert.equal(assistant.info?.error?.detail, 'Invalid API key');
    assert.equal(assistant.info?.error?.statusCode, 401);

    const { framesFromMessages } = await import('../server/native/agent-frames.mjs');
    const frames = framesFromMessages(store.listMessages('ses_trustauth1'), store.workspaceFor('ses_trustauth1'));
    const reply = frames.find((frame) => frame.role === 'assistant');
    assert.match(reply?.content || '', /^\[Runtime note\] This turn failed before any answer was produced/);
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});
