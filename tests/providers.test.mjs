import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-provider-test-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const providers = await import('../server/native/providers.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');
const ownerId = 'stream@example.com';
store.createUser(ownerId, 'hash');

const testProviders = [
  { id: 'openai', name: 'Test OpenAI', protocol: 'openai', baseURL: 'https://1.1.1.1/v1', key: 'sk-test' },
  { id: 'anthropic', name: 'Test Anthropic', protocol: 'anthropic', baseURL: 'https://1.1.1.1/anthropic', key: 'sk-ant-test' },
  { id: 'google', name: 'Test Gemini', protocol: 'google', baseURL: 'https://1.1.1.1/google', key: 'g-test' },
];
for (const config of testProviders) {
  providerConfigs.upsertProviderConfig(ownerId, {
    id: config.id,
    name: config.name,
    protocol: config.protocol,
    baseURL: config.baseURL,
    enabled: true,
  });
  store.setProviderKey(ownerId, config.id, config.key);
}

function sseResponse(events) {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('OpenAI-compatible provider streams text and reconstructs tool arguments', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    return sseResponse([
      { choices: [{ delta: { content: 'Проверяю ' } }] },
      { choices: [{ delta: { content: 'проект.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]);
  };
  try {
    const deltas = [];
    const result = await providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
      onTextDelta: (delta) => deltas.push(delta),
    });
    assert.equal(deltas.join(''), 'Проверяю проект.');
    assert.equal(result.text, 'Проверяю проект.');
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'read', arguments: { path: 'README.md' } }]);
  } finally { globalThis.fetch = original; }
});

test('Anthropic provider streams text and tool input JSON', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Открываю файл. ' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  ]);
  try {
    const deltas = [];
    const result = await providers.callModel(ownerId, { providerID: 'anthropic', modelID: 'claude-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
      onTextDelta: (delta) => deltas.push(delta),
    });
    assert.equal(deltas.join(''), 'Открываю файл. ');
    assert.deepEqual(result.toolCalls[0], { id: 'toolu_1', name: 'read', arguments: { path: 'a.ts' } });
    assert.equal(result.finish, 'tool_use');
  } finally { globalThis.fetch = original; }
});

test('Gemini provider streams text and function calls', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /streamGenerateContent/);
    return sseResponse([
      { candidates: [{ content: { parts: [{ text: 'Готовлю ' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'изменение.' }, { functionCall: { name: 'write', args: { path: 'x.txt', content: 'ok' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } },
    ]);
  };
  try {
    const deltas = [];
    const result = await providers.callModel(ownerId, { providerID: 'google', modelID: 'gemini-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }],
      onTextDelta: (delta) => deltas.push(delta),
    });
    assert.equal(deltas.join(''), 'Готовлю изменение.');
    assert.equal(result.toolCalls[0].name, 'write');
    assert.equal(result.finish, 'STOP');
  } finally { globalThis.fetch = original; }
});

test('non-streaming provider calls retry transient HTTP errors', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await providers.probeModel(ownerId, 'openai', { modelId: 'gpt-test' });
    assert.equal(result.available, true);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
