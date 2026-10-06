import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-live-tools-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const events = await import('../server/native/events.mjs');
const providers = await import('../server/native/providers.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');

const ownerId = 'live-tools@example.com';
const providerId = 'openai';
store.createUser(ownerId, 'hash');
providerConfigs.upsertProviderConfig(ownerId, { id: providerId, name: 'Live Tools OpenAI', protocol: 'openai', baseURL: 'https://1.1.1.1/v1', enabled: true });
store.setProviderKey(ownerId, providerId, 'sk-live-tools');
providers.setProviderTransportForTests((url, init) => globalThis.fetch(url, init));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const sse = (items) => new Response(items.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
// Delivers the events one by one with a pause, like a model that is still typing.
const slowSse = (items, gapMs = 100) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const e of items) {
        controller.enqueue(encoder.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`));
        await new Promise((r) => setTimeout(r, gapMs));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const toolDelta = (index, fn, id) => ({ choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: fn }] } }] });

test('tool cards are drawn while the model writes the call and stay one card per call through the run', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_livetools1';
  store.createChat(sid, ownerId, 'Live');
  const frames = [];
  const unsubscribe = events.subscribe(sid, (frame) => frames.push(frame.event));
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return slowSse([
        toolDelta(0, { name: 'write', arguments: '' }, 'call_w'),
        toolDelta(0, { arguments: '{"path":"live/a.txt","content":"first part ' }),
        toolDelta(0, { arguments: 'second part"}' }),
        toolDelta(1, { name: 'read', arguments: '{"path":"live/a.txt"}' }, 'call_r'),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]);
    }
    return sse([{ choices: [{ delta: { content: 'Готово.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
  };
  try {
    const assistant = await agent.runTurn({ sessionId: sid, ownerId, parts: [{ type: 'text', text: 'Запиши файл' }], model: { providerID: providerId, modelID: 'gpt-test' }, system: '' });
    const tools = assistant.parts.filter((p) => p.type === 'tool' && p.tool !== 'review');
    assert.deepEqual(tools.map((p) => [p.tool, p.state.status, p.callID]), [['write', 'completed', 'call_w'], ['read', 'completed', 'call_r']]);

    const updates = frames.filter((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'tool').map((e) => e.properties.part);
    const writeId = tools[0].id;
    const history = updates.filter((p) => p.id === writeId).map((p) => p.state.status + (p.state.metadata?.streamingArgs ? '*' : ''));
    // streamed while the arguments arrive -> queued -> running -> completed, all on the same card
    assert.equal(history[0], 'running*');
    assert.ok(history.indexOf('pending') > 0, history.join(','));
    assert.ok(history.indexOf('running') > history.indexOf('pending'), history.join(','));
    assert.equal(history.at(-1), 'completed');
    const live = updates.find((p) => p.id === writeId && p.state.metadata?.streamingArgs && p.state.metadata.output);
    assert.ok(live, 'the file body was shown before the call finished');
    assert.equal(live.state.title, 'live/a.txt');

    // the second card was queued before the first one finished
    const firstCompleted = updates.findIndex((p) => p.id === writeId && p.state.status === 'completed');
    const readQueued = updates.findIndex((p) => p.id === tools[1].id && p.state.status === 'pending');
    assert.ok(readQueued !== -1 && readQueued < firstCompleted);

    assert.equal(store.listMessages(sid).at(-1).parts.filter((p) => p.type === 'tool' && p.tool !== 'review').length, 2);
    assert.ok(!frames.some((e) => e.type === 'message.part.removed'), 'nothing had to be discarded');
  } finally {
    unsubscribe();
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('a call cut off by a dropped stream ends as a failed card, never as a spinner', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_livetools2';
  store.createChat(sid, ownerId, 'Live cut');
  const frames = [];
  const unsubscribe = events.subscribe(sid, (frame) => frames.push(frame.event));
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return sse([
        toolDelta(0, { name: 'write', arguments: '{"path":"x.txt","content":"half' }, 'call_x'),
        { error: { message: 'upstream boom', code: 502 } },
      ]);
    }
    return sse([{ choices: [{ delta: { content: 'Повторю короче.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
  };
  try {
    const assistant = await agent.runTurn({ sessionId: sid, ownerId, parts: [{ type: 'text', text: 'Запиши' }], model: { providerID: providerId, modelID: 'gpt-test' }, system: '' });
    const tools = assistant.parts.filter((p) => p.type === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].state.status, 'error');
    assert.equal(tools[0].state.metadata.incompleteArguments, true);
    assert.ok(!tools[0].state.metadata.streamingArgs);
    const drawn = frames.filter((e) => e.type === 'message.part.updated' && e.properties.part?.id === tools[0].id);
    assert.equal(drawn[0].properties.part.state.metadata.streamingArgs, true, 'the half-written call was visible while streaming');
    assert.equal(call, 2);
  } finally {
    unsubscribe();
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});

test('a task card shows the subagent timeline while it works', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_livetools3';
  store.createChat(sid, ownerId, 'Live task');
  const frames = [];
  const unsubscribe = events.subscribe(sid, (frame) => frames.push(frame.event));
  const original = globalThis.fetch;
  let subagentCalls = 0;
  let mainCalls = 0;
  const json = (message, finish) => new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.stream) {
      subagentCalls += 1;
      await new Promise((r) => setTimeout(r, 150));
      if (subagentCalls === 1) {
        return json({ content: 'Сначала посмотрю файлы.', tool_calls: [{ id: 'sub_list', type: 'function', function: { name: 'list', arguments: '{}' } }] }, 'tool_calls');
      }
      return json({ content: 'Отчёт подагента: всё найдено.' }, 'stop');
    }
    mainCalls += 1;
    if (mainCalls === 1) {
      const args = JSON.stringify({ description: 'Inspect', prompt: 'Посмотри структуру.' });
      return sse([toolDelta(0, { name: 'task', arguments: args }, 'call_task'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']);
    }
    return sse([{ choices: [{ delta: { content: 'Готово.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
  };
  try {
    const assistant = await agent.runTurn({ sessionId: sid, ownerId, parts: [{ type: 'text', text: 'Изучи' }], model: { providerID: providerId, modelID: 'gpt-test' }, system: '' });
    const task = assistant.parts.find((p) => p.type === 'tool' && p.tool === 'task');
    assert.equal(task.state.status, 'completed');
    const timeline = frames
      .filter((e) => e.type === 'message.part.updated' && e.properties.part?.id === task.id && e.properties.part.state.status === 'running')
      .map((e) => e.properties.part.state.metadata?.output)
      .filter(Boolean);
    assert.ok(timeline.length >= 2, `expected live timeline updates, got ${timeline.length}`);
    const last = timeline.at(-1);
    assert.match(last, /Подагент «[^»]+» запущен/);
    assert.match(last, /→ list/);
    assert.match(last, /Модель: Сначала посмотрю файлы/);
    assert.match(task.state.output, /Отчёт подагента/);
  } finally {
    unsubscribe();
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});
