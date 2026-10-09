import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-overflow-test-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const { CONTEXT_OVERFLOW_PATTERNS, isContextOverflowMessage } = await import('../server/native/providers/overflow.mjs');
const { isContextOverflowError } = await import('../server/native/agent/turn-loop.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// One real-world style message per pattern, so every pattern is exercised and a typo in one of them is caught.
const OVERFLOW_MESSAGES = [
  'prompt is too long: 213462 tokens > 200000 maximum', // Anthropic
  '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}',
  'Input is too long for requested model.', // Amazon Bedrock
  'Your input exceeds the context window of this model. Please adjust your input and try again.', // OpenAI Responses
  "Your request exceeds the model's maximum context length of 131,072 tokens.",
  'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).', // Gemini
  'The number of tokens in request more than max tokens allowed (131072).',
  "This model's maximum prompt length is 131072 but the request contains 537812 tokens.", // xAI
  'Please reduce the length of the messages or completion.',
  "This model's maximum context length is 8192 tokens. However, your messages resulted in 9031 tokens.", // OpenAI chat
  'The input exceeds the maximum allowed input length of 262,144 tokens.',
  "Input (200000 tokens) is longer than the model's context length (131072 tokens).",
  'prompt token count of 202345 exceeds the limit of 128000', // GitHub Copilot
  'the request exceeds the available context size, try increasing it', // llama.cpp
  'Requested token count (5000) is greater than the context length (4096).',
  'invalid params, context window exceeds limit (2013)', // MiniMax
  'Your request exceeded model token limit: 262144 (requested: 310000)', // Kimi
  'context_length_exceeded',
  'Request Entity Too Large',
  'Trying to keep 8000 tokens, but the context length is only 4096 tokens.',
  'Input length 300000 exceeds the model context length 262144.',
  'prompt too long; exceeded max context length by 5000 tokens',
  'Prompt contains 140000 tokens and 0 draft tokens, too large for model with 131072 maximum context length', // Mistral
  'the prompt has 9,000 tokens, but the configured context size is 8,192 tokens', // llama.cpp
  'finish_reason: model_context_window_exceeded',
  'Too many tokens in the request: 500000',
  'Token limit exceeded for this request.',
];

test('every opencode overflow pattern is covered by a sample message', () => {
  for (const pattern of CONTEXT_OVERFLOW_PATTERNS) {
    assert.ok(
      OVERFLOW_MESSAGES.some((message) => pattern.test(message)),
      `no sample message for ${pattern}`,
    );
  }
});

test('provider wordings for "request does not fit the context" are recognised', () => {
  for (const message of OVERFLOW_MESSAGES) assert.equal(isContextOverflowMessage(message), true, message);
});

test('the shorter pre-opencode wording keeps working', () => {
  for (const message of ['Prompt exceeds max length', 'maximum context length', 'request too large', 'input too long', 'context window']) {
    assert.equal(isContextOverflowMessage(message), true, message);
  }
});

test('rate limits and outages that mention tokens are not overflow', () => {
  for (const message of [
    'Throttling error: Too many tokens, please wait before trying again.',
    'Service Unavailable: input is too long to process right now',
    'Rate limit reached for gpt-4o on tokens per min (TPM): too many tokens',
    '429 Too Many Requests',
    'You exceeded your current rate limit: token limit exceeded',
  ]) {
    assert.equal(isContextOverflowMessage(message), false, message);
  }
});

test('unrelated errors and empty input are not overflow', () => {
  for (const message of ['Internal server error', 'Invalid API key', 'model not found', '400 Bad Request', '', ' ', null, undefined]) {
    assert.equal(isContextOverflowMessage(message), false, String(message));
  }
});

test('isContextOverflowError checks status, error code and message including the response body', () => {
  assert.equal(isContextOverflowError({ message: 'x', statusCode: 413 }), true);
  assert.equal(isContextOverflowError({ message: 'x', status: 413 }), true);
  assert.equal(
    isContextOverflowError({ message: 'Bad Request', statusCode: 400, body: { error: { code: 'context_length_exceeded' } } }),
    true,
  );
  assert.equal(
    isContextOverflowError({
      message: 'Bad Request',
      statusCode: 400,
      body: { error: { message: 'The input token count (5) exceeds the maximum number of tokens allowed (4).' } },
    }),
    true,
  );
  assert.equal(isContextOverflowError(new Error('prompt token count of 202345 exceeds the limit of 128000')), true);
  assert.equal(isContextOverflowError({ message: 'Too Many Requests', statusCode: 429 }), false);
  assert.equal(isContextOverflowError({ message: 'Bad Request', statusCode: 400 }), false);
  // An empty-bodied 400 must stay a plain error: treating it as overflow would shrink the learned context budget.
  assert.equal(isContextOverflowError({ message: '400 Bad Request', statusCode: 400, body: null }), false);
  assert.equal(isContextOverflowError(null), false);
});
