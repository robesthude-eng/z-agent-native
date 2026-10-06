import assert from 'node:assert/strict';
import test from 'node:test';
import { callAnthropic, callOpenAI, streamEventError } from '../server/native/providers/streaming.mjs';

function sse(events) {
  const text = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const frames = [{ role: 'user', content: 'hi' }];
const openai = { key: 'k', modelId: 'm-stream-err', spec: { baseURL: 'https://example.test/v1', kind: 'openai' }, trustedBaseURL: true };
const anthropic = { key: 'k', modelId: 'claude-test', spec: { baseURL: 'https://example.test/anthropic', kind: 'anthropic' }, trustedBaseURL: true };

test('streamEventError ignores ordinary events and shapes provider errors', () => {
  assert.equal(streamEventError({ choices: [{ delta: { content: 'x' } }] }), null);
  assert.equal(streamEventError({ error: null }), null);
  assert.equal(streamEventError('x'), null);
  const http = streamEventError({ error: { message: 'upstream boom', code: 502 } });
  assert.equal(http.statusCode, 502);
  assert.equal(http.message, 'upstream boom');
  const overloaded = streamEventError({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.equal(overloaded.statusCode, 529);
  assert.equal(streamEventError({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }).statusCode, undefined);
});

test('an HTTP 200 stream that only carries an error event is retried, not returned as an empty answer', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return sse([{ error: { message: 'upstream boom', code: 502 } }]);
    return sse([{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }, '[DONE]']);
  };
  try {
    const result = await callOpenAI(openai, { system: 's', frames, tools: [], onTextDelta: () => {} });
    assert.equal(result.text, 'OK');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('a non-retryable in-stream error surfaces as a failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sse([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'error', error: { type: 'invalid_request_error', message: 'prompt rejected' } },
  ]);
  try {
    await assert.rejects(
      callAnthropic(anthropic, { system: 's', frames, tools: [], onTextDelta: () => {} }),
      /prompt rejected/,
    );
  } finally { globalThis.fetch = original; }
});

test('a transient in-stream error after partial text is reported as an interrupted stream', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sse([
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial answer' } },
    { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
  ]);
  try {
    const result = await callAnthropic(anthropic, { system: 's', frames, tools: [], onTextDelta: () => {} });
    assert.equal(result.interrupted, true);
    assert.equal(result.text, 'Partial answer');
  } finally { globalThis.fetch = original; }
});
