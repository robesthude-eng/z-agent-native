import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolCallSink, previewTitle } from '../server/native/agent/tool-stream.mjs';
import { settleOpenToolParts } from '../server/native/agent/message-parts.mjs';
import { parsePartialJson, toolArgsPreview } from '../server/native/partial-json.mjs';
import { createLiveOutput } from '../server/native/tools/dispatcher.mjs';
import { callAnthropic, callGoogle, callOpenAI } from '../server/native/providers/streaming.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- partial JSON ----------------------------------------------------------

test('parsePartialJson reads every prefix of a streamed document without throwing', () => {
  const doc = JSON.stringify({ path: 'src/a.js', content: 'line1\nline "two"\\ \u00e9\u4e2d', n: 12.5, ok: true, list: [1, { a: 'x' }], nothing: null });
  let parsed = 0;
  for (let i = 1; i <= doc.length; i++) {
    const value = parsePartialJson(doc.slice(0, i));
    if (value !== null) parsed += 1;
  }
  assert.ok(parsed > doc.length * 0.8, `only ${parsed}/${doc.length} prefixes parsed`);
  assert.deepEqual(parsePartialJson(doc), JSON.parse(doc));
  assert.equal(parsePartialJson(''), null);
  assert.equal(parsePartialJson('   '), null);
});

test('parsePartialJson exposes the string being typed and drops a dangling key', () => {
  assert.deepEqual(parsePartialJson('{"path":"a.txt","content":"hel'), { path: 'a.txt', content: 'hel' });
  assert.deepEqual(parsePartialJson('{"path":"a.txt","con'), { path: 'a.txt' });
  assert.deepEqual(parsePartialJson('{"path":"a.txt",'), { path: 'a.txt' });
  assert.deepEqual(parsePartialJson('{"content":"x\\'), { content: 'x' });
  assert.deepEqual(parsePartialJson('{"content":"x\\u00'), { content: 'x' });
});

test('toolArgsPreview keeps the header small and sends the body tail only', () => {
  const big = 'x'.repeat(10_000);
  const preview = toolArgsPreview(`{"path":"a.txt","content":"${big}`);
  assert.equal(preview.input.path, 'a.txt');
  assert.equal(preview.input.content, undefined);
  assert.ok(preview.output.length < 4200);
  assert.ok(preview.output.endsWith('xxx'));
  assert.deepEqual(toolArgsPreview('not json at all'), { input: {}, output: '' });
  assert.deepEqual(toolArgsPreview({ command: 'ls -la' }).input, { command: 'ls -la' });
  assert.equal(previewTitle('bash', { command: 'ls\nsecond' }), 'ls');
  assert.equal(previewTitle('bash', {}), 'bash');
});

// ---- sink ------------------------------------------------------------------

function harness() {
  const events = [];
  const assistant = { id: 'm1', sessionID: 's1', parts: [] };
  let persisted = 0;
  const emit = (sessionId, type, data) => events.push({ sessionId, type, part: data.part ? JSON.parse(JSON.stringify(data.part)) : null, data });
  const sink = createToolCallSink(assistant, { emit, persist: () => { persisted += 1; }, throttleMs: 20 });
  return { events, assistant, sink, persisted: () => persisted };
}

test('a card appears as soon as the tool name arrives and follows the arguments', async () => {
  const { events, assistant, sink } = harness();
  sink.onToolCall({ key: 0, id: 'c1', name: 'write', args: '' });
  assert.equal(assistant.parts.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].part.state.status, 'running');
  sink.onToolCall({ key: 0, id: 'c1', name: 'write', args: '{"path":"a.txt","content":"he' });
  sink.onToolCall({ key: 0, id: 'c1', name: 'write', args: '{"path":"a.txt","content":"hello' });
  await sleep(60);
  const last = events.at(-1).part;
  assert.equal(last.state.title, 'a.txt');
  assert.equal(last.state.metadata.output, 'hello');
  assert.equal(last.state.input.path, 'a.txt');
  // updates in a burst are coalesced
  assert.ok(events.length <= 3, `got ${events.length} events`);
  sink.discard();
});

test('bind queues every call, reuses streamed cards and removes stale ones', () => {
  const { events, assistant, sink, persisted } = harness();
  sink.onToolCall({ key: 0, id: 'a', name: 'read', args: '{"path":"x"}' });
  sink.onToolCall({ key: 1, id: 'b', name: 'bash', args: '{"command":"ls"}' });
  const streamedIds = assistant.parts.map((part) => part.id);
  const parts = sink.bind([
    { id: 'a', name: 'read', arguments: { path: 'x' } },
    { id: 'c', name: 'grep', arguments: { pattern: 'p' } },
  ]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].id, streamedIds[0], 'the streamed card is reused');
  assert.notEqual(parts[1].id, streamedIds[1], 'a card with another tool name is not reused');
  assert.deepEqual(assistant.parts.map((p) => p.tool), ['read', 'grep']);
  assert.ok(parts.every((p) => p.state.status === 'pending'));
  assert.equal(parts[1].callID, 'c');
  assert.equal(persisted(), 1, 'the removal is saved');
  assert.ok(events.some((e) => e.type === 'message.part.removed'), 'and announced to clients');
  assert.ok(events.filter((e) => e.part?.state?.status === 'pending').length >= 2);
});

test('discard removes cards drawn by a failed attempt and stops pending timers', async () => {
  const { events, assistant, sink } = harness();
  sink.onToolCall({ key: 0, id: 'a', name: 'write', args: '{"path":"p"' });
  sink.onToolCall({ key: 0, id: 'a', name: 'write', args: '{"path":"p","content":"zzz' });
  sink.discard();
  const count = events.length;
  await sleep(50);
  assert.equal(assistant.parts.length, 0);
  assert.equal(events.length, count, 'no update after discard');
});

test('settleOpenToolParts closes queued and running cards of a finished turn', () => {
  const emitted = [];
  const assistant = { id: 'm', sessionID: 's', parts: [
    { id: '1', type: 'tool', tool: 'bash', state: { status: 'completed', output: 'ok' } },
    { id: '2', type: 'tool', tool: 'bash', state: { status: 'pending', input: {} } },
    { id: '3', type: 'tool', tool: 'bash', state: { status: 'running', input: {}, time: { start: 1 } } },
    { id: '4', type: 'text', text: 'hi' },
  ] };
  let saved = 0;
  const n = settleOpenToolParts(assistant, { putMessage: () => { saved += 1; }, emit: (...args) => emitted.push(args) });
  assert.equal(n, 2);
  assert.equal(saved, 1);
  assert.equal(assistant.parts[0].state.status, 'completed');
  assert.equal(assistant.parts[1].state.status, 'error');
  assert.equal(assistant.parts[2].state.status, 'error');
  assert.equal(emitted.length, 2);
  assert.equal(settleOpenToolParts(assistant, { putMessage() {}, emit() {} }), 0);
});

// ---- live output -----------------------------------------------------------

test('live output: first chunk is immediate, bursts are coalesced, last state is delivered', async () => {
  const seen = [];
  const live = createLiveOutput((text) => seen.push(text), { intervalMs: 40 });
  live.push('a', '');
  assert.equal(seen.length, 1, 'leading edge');
  live.push('ab', '');
  live.push('abc', '');
  live.push('abcd', '');
  assert.equal(seen.length, 1);
  await sleep(90);
  assert.equal(seen.length, 2, 'trailing edge');
  assert.ok(seen[1].endsWith('abcd'));
  live.push('abcde', '');
  assert.equal(seen.length, 3, 'a quiet period makes the next chunk immediate again');
  live.push('abcdef', '');
  live.stop();
  await sleep(60);
  assert.equal(seen.length, 3, 'nothing is delivered after stop');
});

// ---- providers -------------------------------------------------------------

function sse(events) {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const frames = [{ role: 'user', content: 'hi' }];
const openai = { key: 'k', modelId: 'm-tool-stream', spec: { baseURL: 'https://example.test/v1', kind: 'openai' }, trustedBaseURL: true };
const anthropic = { key: 'k', modelId: 'claude-ts', spec: { baseURL: 'https://example.test/anthropic', kind: 'anthropic' }, trustedBaseURL: true };
const google = { key: 'k', modelId: 'gem-ts', spec: { baseURL: 'https://example.test/google', kind: 'google' }, trustedBaseURL: true };

async function withFetch(response, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response();
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('OpenAI: onToolCall fires for every argument delta, per tool index', async () => {
  const reports = [];
  const result = await withFetch(() => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'write', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a",' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]), () => callOpenAI(openai, { system: 's', frames, tools: [], onTextDelta: () => {}, onToolCall: (c) => reports.push({ ...c }) }));
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(reports.map((r) => r.key), [0, 0, 0, 1]);
  assert.equal(reports[2].args, '{"path":"a","content":"hi"}');
  assert.equal(reports[0].name, 'write');
});

test('Anthropic: input_json_delta streams into onToolCall, and a throwing callback cannot break the stream', async () => {
  const reports = [];
  const result = await withFetch(() => sse([
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu', name: 'write', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b"' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ',"content":"x"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]), () => callAnthropic(anthropic, { system: 's', frames, tools: [], onTextDelta: () => {}, onToolCall: (c) => { reports.push(c.args); throw new Error('ui bug'); } }));
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'b', content: 'x' });
  assert.equal(reports.length, 3);
  assert.equal(reports.at(-1), '{"path":"b","content":"x"}');
});

test('Google: whole function calls are reported as they arrive', async () => {
  const reports = [];
  const result = await withFetch(() => sse([
    { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { path: 'a' } } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'bash', args: { command: 'ls' } } }] }, finishReason: 'STOP' }] },
  ]), () => callGoogle(google, { system: 's', frames, tools: [], onTextDelta: () => {}, onToolCall: (c) => reports.push(c) }));
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(reports.map((r) => [r.key, r.name]), [[0, 'read'], [1, 'bash']]);
});
