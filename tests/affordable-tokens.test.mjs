import assert from 'node:assert/strict';
import test from 'node:test';
import { affordableTokens, callOpenAI } from '../server/native/providers/streaming.mjs';

test('OpenRouter "can only afford" error is retried with an affordable max_tokens', async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { code: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 3666.' } }), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const resolved = { key: 'k', modelId: 'm-afford-test', spec: { baseURL: 'https://openrouter.ai/api/v1', kind: 'openai' }, trustedBaseURL: true };
    const result = await callOpenAI(resolved, { system: 's', frames: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal(result.text, 'OK');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, undefined);
    assert.equal(bodies[1].max_tokens, Math.floor(3666 * 0.95));
    // The cap is remembered: the next call starts with it instead of failing first.
    await callOpenAI(resolved, { system: 's', frames: [{ role: 'user', content: 'again' }], tools: [] });
    assert.equal(bodies[2].max_tokens, Math.floor(3666 * 0.95));
  } finally { globalThis.fetch = original; }
  assert.equal(affordableTokens({ message: 'nothing' }), 0);
});
