import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-loop-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const providers = await import('../server/native/providers.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');

const ownerId = 'agent@example.com';
const providerId = 'openai';
store.createUser(ownerId, 'hash');
providerConfigs.upsertProviderConfig(ownerId, {
  id: providerId,
  name: 'Agent Test OpenAI',
  protocol: 'openai',
  baseURL: 'https://1.1.1.1/v1',
  enabled: true,
});
store.setProviderKey(ownerId, providerId, 'sk-agent-test');
providers.setProviderTransportForTests((url, init) => globalThis.fetch(url, init));

function sse(events) {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function waitFor(fn, timeout = 1500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition timeout');
}

test('question suspends and resumes the same native turn without creating a second user message', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_questionnative1';
  store.createChat(sid, ownerId, 'Новый чат');
  const original = globalThis.fetch;
  let streamCall = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    streamCall += 1;
    if (streamCall === 1) {
      const args = JSON.stringify({ questions: [{ header: 'Mode', question: 'Как продолжить?', options: [{ label: 'Авто' }], allowCustomResponse: true }] });
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_question', function: { name: 'question', arguments: args } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }
    return sse([
      { choices: [{ delta: { content: 'Продолжаю с вашим ответом.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };

  try {
    const turn = agent.runTurn({
      sessionId: sid,
      ownerId,
      parts: [{ type: 'text', text: 'Настрой проект' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });
    const question = await waitFor(() => store.listPendingQuestions(sid)[0]);
    assert.equal(agent.answerQuestion(sid, question.id, [['мой вариант']]), true);
    const assistant = await turn;
    const messages = store.listMessages(sid);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(messages.filter((m) => m.role === 'user').length, 1);
    assert.match(assistant.parts.find((p) => p.type === 'text')?.text || '', /Продолжаю/);
    const qPart = assistant.parts.find((p) => p.type === 'tool' && p.tool === 'question');
    assert.equal(qPart?.state?.status, 'completed');
    assert.deepEqual(qPart?.state?.metadata?.answers, [['мой вариант']]);
    assert.equal(streamCall, 2);
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('task runs a nested read-only subagent loop and returns its report to the parent turn', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_subagentnative1';
  store.createChat(sid, ownerId, 'Новый чат');
  const original = globalThis.fetch;
  let mainStreamCalls = 0;
  let subagentCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.stream) {
      subagentCalls += 1;
      assert.match(body.messages?.[0]?.content || '', /read-only subagent/i);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Отчёт подагента: найден README.md.' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    mainStreamCalls += 1;
    if (mainStreamCalls === 1) {
      const args = JSON.stringify({ description: 'Inspect docs', prompt: 'Проверь структуру документации.' });
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_task', function: { name: 'task', arguments: args } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }
    return sse([
      { choices: [{ delta: { content: 'Проверка завершена.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };

  try {
    const assistant = await agent.runTurn({
      sessionId: sid,
      ownerId,
      parts: [{ type: 'text', text: 'Изучи документацию' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });
    const taskPart = assistant.parts.find((p) => p.type === 'tool' && p.tool === 'task');
    assert.equal(taskPart?.state?.status, 'completed', String(taskPart?.state?.output || 'task produced no output'));
    assert.match(String(taskPart?.state?.output || ''), /Отчёт подагента/);
    assert.equal(taskPart?.state?.metadata?.subagent, true);
    assert.equal(subagentCalls, 1);
    assert.equal(mainStreamCalls, 2);
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});


test('typed attachments stay separate from user text while model receives workspace context', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_attachmentnative1';
  store.createChat(sid, ownerId, 'Новый чат');
  const workspace = store.workspaceFor(sid);
  fs.mkdirSync(path.join(workspace, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'uploads', 'notes.txt'), 'private file body');

  const original = globalThis.fetch;
  let providerUserContent = '';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages.findLast((m) => m.role === 'user');
    providerUserContent = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content || '');
    return sse([
      { choices: [{ delta: { content: 'Файл вижу в workspace.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };

  try {
    await agent.runTurn({
      sessionId: sid,
      ownerId,
      parts: [
        { type: 'attachment', name: 'notes.txt', path: 'uploads/notes.txt', size: 17, kind: 'text', mime: 'text/plain' },
        { type: 'text', text: 'Посмотри приложенный файл' },
      ],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });
    const user = store.listMessages(sid).find((m) => m.role === 'user');
    assert.deepEqual(user.parts.map((p) => p.type), ['attachment', 'text']);
    assert.equal(user.parts.find((p) => p.type === 'text')?.text, 'Посмотри приложенный файл');
    assert.equal(user.parts.find((p) => p.type === 'attachment')?.path, 'uploads/notes.txt');
    assert.equal(user.parts.some((p) => typeof p.text === 'string' && p.text.includes('<attachments>')), false);
    assert.match(providerUserContent, /uploads\/notes\.txt/);
    assert.doesNotMatch(providerUserContent, /private file body/);
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test.after(() => providers.setProviderTransportForTests(null));
