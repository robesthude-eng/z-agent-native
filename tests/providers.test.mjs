import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-provider-test-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_RELAY_URL = 'https://1.1.1.2/relay';

const store = await import('../server/native/store.mjs');
const providers = await import('../server/native/providers.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');
const ownerId = 'stream@example.com';
store.createUser(ownerId, 'hash');
providers.setProviderTransportForTests((url, init) => globalThis.fetch(url, init));

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

test('streaming provider calls keep retrying TLS after the default attempt budget', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 3) {
      throw new Error('Client network socket disconnected before secure TLS connection was established');
    }
    return sseResponse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };
  try {
    const result = await providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
      onTextDelta: () => {},
    });
    assert.equal(result.text, 'OK');
    assert.equal(calls, 4);
  } finally { globalThis.fetch = original; }
});

test('streaming provider calls retry a TLS handshake drop before the first token', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('Client network socket disconnected before secure TLS connection was established');
    }
    return sseResponse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };
  try {
    const result = await providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
      onTextDelta: () => {},
    });
    assert.equal(result.text, 'OK');
    assert.equal(calls, 2);
    assert.equal(providers.isNetworkTransportError(new Error('Client network socket disconnected before secure TLS connection was established')), true);
  } finally { globalThis.fetch = original; }
});

test('streaming provider calls retry read ECONNRESET before the first token', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('read ECONNRESET');
      err.code = 'ECONNRESET';
      throw err;
    }
    return sseResponse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };
  try {
    const result = await providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
      onTextDelta: () => {},
    });
    assert.equal(result.text, 'OK');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('non-streaming provider calls retry transient HTTP errors', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response(JSON.stringify({ error: { message: 'busy' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await providers.probeModel(ownerId, 'openai', { modelId: 'gpt-test' });
    assert.equal(result.available, true);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('model discovery falls back to the direct endpoint after relay transport termination', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.startsWith('https://1.1.1.2/relay/')) throw new TypeError('terminated');
    return new Response(JSON.stringify({ data: [
      { id: 'glm-test', name: 'GLM Test' },
      { id: 'glm-test-2' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await providers.fetchModels(ownerId, 'openai', { force: true });
    assert.equal(result.status, 'live');
    assert.deepEqual(result.models.map((model) => model.id), ['glm-test', 'glm-test-2']);
    assert.equal(urls.filter((url) => url.startsWith('https://1.1.1.2/relay/')).length, 5);
    assert.equal(urls.at(-1), 'https://1.1.1.1/v1/models');
  } finally { globalThis.fetch = original; }
});

test('idle watchdog keeps a live stream and aborts only after silence', async () => {
  const watchdog = providers.idleTimeoutSignal({ idleMs: 80, hardMs: 5_000, pollMs: 20 });
  const keepAlive = setInterval(() => watchdog.touch(), 15);
  try {
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(watchdog.signal.aborted, false);
  } finally {
    clearInterval(keepAlive);
  }
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(watchdog.signal.aborted, true);
  watchdog.cleanup();
});

test('idle watchdog still aborts at the hard ceiling while tokens keep arriving', async () => {
  const watchdog = providers.idleTimeoutSignal({ idleMs: 5_000, hardMs: 80, pollMs: 20 });
  const keepAlive = setInterval(() => watchdog.touch(), 15);
  try {
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(watchdog.signal.aborted, true);
  } finally {
    clearInterval(keepAlive);
    watchdog.cleanup();
  }
});

test('streaming prefers the direct provider URL and falls back to the relay', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    if (!value.includes('/relay/')) {
      const err = new Error('read ECONNRESET');
      err.code = 'ECONNRESET';
      throw err;
    }
    return sseResponse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };
  try {
    const result = await providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
      onTextDelta: () => {},
    });
    assert.equal(result.text, 'OK');
    assert.match(urls[0], /^https:\/\/1\.1\.1\.1\/v1\/chat\/completions$/);
    assert.ok(urls.some((url) => url.startsWith('https://1.1.1.2/relay/')));
  } finally { globalThis.fetch = original; }
});

test('a user abort is not retried as a dropped provider socket', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    controller.abort();
    const err = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    if (init?.signal?.aborted) throw err;
    throw err;
  };
  try {
    await assert.rejects(
      () => providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
        system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
        signal: controller.signal,
        onTextDelta: () => {},
      }),
      (err) => err?.name === 'AbortError' || /abort/i.test(String(err?.message || '')),
    );
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('provider URL is blocked before relay wrapping can hide a private destination', async () => {
  providerConfigs.upsertProviderConfig(ownerId, {
    id: 'blocked-local',
    name: 'Blocked Local',
    protocol: 'openai',
    baseURL: 'https://127.0.0.1:8765/v1',
    enabled: true,
  });
  store.setProviderKey(ownerId, 'blocked-local', 'sk-local');

  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('network should not be reached');
  };
  try {
    const result = await providers.fetchModels(ownerId, 'blocked-local', { force: true });
    assert.equal(result.status, 'unavailable');
    assert.match(result.error, /Локальные|служебные/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('streaming waits out a 429 and continues the same turn', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        error: { message: 'Error from provider (Console): Rate limit exceeded. Please try again later.' },
      }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return sseResponse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };
  try {
    const result = await providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
      onTextDelta: () => {},
    });
    assert.equal(result.text, 'OK');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('a Console rate-limit payload is retryable even without HTTP 429', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        error: { message: 'Error from provider (Console): Rate limit exceeded. Please try again later.' },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return sseResponse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  };
  try {
    const result = await providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
      system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
      onTextDelta: () => {},
    });
    assert.equal(result.text, 'OK');
    assert.equal(calls, 2);
    assert.equal(providers.isRateLimitProviderError({
      statusCode: 400,
      message: 'Error from provider (Console): Rate limit exceeded. Please try again later.',
    }), true);
  } finally { globalThis.fetch = original; }
});

test('failFastRateLimit gives Autopilot the 429 immediately instead of waiting minutes', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      error: { message: 'Error from provider (Console): Rate limit exceeded. Please try again later.' },
    }), { status: 429, headers: { 'content-type': 'application/json' } });
  };
  try {
    const started = Date.now();
    await assert.rejects(
      () => providers.callModel(ownerId, { providerID: 'openai', modelID: 'gpt-test' }, {
        system: 'test', frames: [{ role: 'user', content: 'hi' }], tools: [],
        onTextDelta: () => {},
        failFastRateLimit: true,
      }),
      (err) => /rate limit/i.test(String(err?.message || '')),
    );
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1_000, 'must not sit on the 5–60s 429 ladder');
  } finally { globalThis.fetch = original; }
});

test('catalog errors shown in settings are masked like chat errors', async () => {
  providerConfigs.upsertProviderConfig(ownerId, {
    id: 'catalog-mask', name: 'Mask', protocol: 'openai', baseURL: 'https://1.1.1.1/mask/v1', enabled: true,
  });
  store.setProviderKey(ownerId, 'catalog-mask', 'sk-mask');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'Free promotion has ended for DeepSeek V4 Flash Free. Subscribe to OpenCode Go - https://opencode.ai/go' },
  }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const result = await providers.fetchModels(ownerId, 'catalog-mask', { force: true });
    assert.equal(result.status, 'unavailable');
    assert.ok(result.error);
    assert.doesNotMatch(result.error, /opencode/i);
    assert.doesNotMatch(result.error, /https?:\/\//);
  } finally { globalThis.fetch = original; }
});

test('ended free-model promotions are unavailable and not advertised to the user', () => {
  const err = Object.assign(new Error('Free promotion has ended for DeepSeek V4 Flash Free. You can continue using the model by subscribing to OpenCode Go - https://opencode.ai/go'), { statusCode: 400 });
  assert.equal(providers.isModelUnavailableError(err), true);
  const publicText = providers.publicProviderErrorMessage(err);
  assert.match(publicText, /недоступна/i);
  assert.doesNotMatch(publicText, /opencode/i);
  assert.doesNotMatch(publicText, /https?:\/\//i);
});

test('opaque Console unavailable payloads are treated as a dead SKU, not dumped in chat', () => {
  const consoleErr = Object.assign(new Error('Error from provider (Console): Upstream request failed: Model is unavailable.'), { statusCode: 400 });
  assert.equal(providers.isModelUnavailableError(consoleErr), true);
  assert.match(providers.publicProviderErrorMessage(consoleErr), /недоступна/i);
  assert.doesNotMatch(providers.publicProviderErrorMessage(consoleErr), /Console/i);

  const jsonErr = Object.assign(new Error('{"model":"mimo-v2.5-free"}'), { statusCode: 400, body: { model: 'mimo-v2.5-free' } });
  assert.equal(providers.isModelUnavailableError(jsonErr), true);
  const publicText = providers.publicProviderErrorMessage(jsonErr);
  assert.match(publicText, /недоступна/i);
  assert.doesNotMatch(publicText, /mimo/i);
  assert.doesNotMatch(publicText, /\{/);
});

test('catalog refresh keeps whatever the provider API listed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
    { id: 'gpt-test', name: 'GPT Test' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await providers.fetchModels(ownerId, 'openai', { force: true });
    assert.deepEqual(result.models.map((model) => model.id), ['deepseek-v4-flash-free', 'gpt-test']);
  } finally { globalThis.fetch = original; }
});

test('truncated tool-call JSON is marked incomplete instead of becoming _raw', () => {
  assert.deepEqual(providers.parseToolArguments('{"path":"a.ts"}'), { ok: true, value: { path: 'a.ts' } });
  const broken = providers.parseToolArguments('{"command":"rm -rf');
  assert.equal(broken.ok, false);
  assert.equal(providers.isIncompleteToolCall({ name: 'bash', arguments: {}, incomplete: true }), true);
  assert.equal(providers.isIncompleteToolCall({ name: 'bash', arguments: { command: 'ls' } }), false);
});

test.after(() => providers.setProviderTransportForTests(null));
