import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-retry-test-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const { RETRY_JITTER_FACTOR, jittered, matchesRetryableMessage } = await import('../server/native/providers/retry-policy.mjs');
const { isTransientProviderError, parseRetryAfterMs } = await import('../server/native/providers/transport.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const response = (headers) => ({ headers: new Headers(headers) });

test('retryable wordings from providers and gateways are recognised', () => {
  for (const message of [
    'Error 503: backend unavailable',
    'rate_limit_error',
    'Too Many Requests',
    'Rate increased too quickly',
    'Overloaded',
    'Service Unavailable',
    'Internal server error',
    'The server had an error while processing your request. You can retry your request.',
    'Provider returned error',
    'failed to fetch',
    'Connection error.',
    'upstream connect error or disconnect/reset before headers',
    'Timeout',
    'Request timed out.',
    'RESOURCE_EXHAUSTED',
    'Please try again later',
    'The model is temporarily at capacity',
  ]) {
    assert.equal(matchesRetryableMessage(message), true, message);
  }
});

test('permanent failures and non-strings are not retryable wordings', () => {
  for (const message of [
    'Invalid API key',
    'Unexpected token } in JSON at position 5003',
    'max_tokens must be at least 1',
    'model not found',
    'getaddrinfo ENOTFOUND api.example.invalid',
    '',
    null,
    undefined,
    503,
  ]) {
    assert.equal(matchesRetryableMessage(message), false, String(message));
  }
});

test('jitter adds up to a quarter of the delay and never shortens it', () => {
  assert.equal(RETRY_JITTER_FACTOR, 0.25);
  assert.equal(jittered(1000, 0), 1000);
  assert.equal(jittered(1000, 1), 1250);
  assert.equal(jittered(1000, 0.5), 1125);
  for (let i = 0; i < 200; i++) {
    const value = jittered(8000);
    assert.ok(value >= 8000 && value <= 10_000, String(value));
  }
});

test('retry-after-ms is honoured before retry-after', () => {
  assert.equal(parseRetryAfterMs(response({ 'retry-after-ms': '1500' })), 1500);
  assert.equal(parseRetryAfterMs(response({ 'retry-after-ms': '250.4', 'retry-after': '30' })), 250);
  assert.equal(parseRetryAfterMs(response({ 'retry-after-ms': '0', 'retry-after': '30' })), 0);
  // An unusable millisecond hint falls back to the standard header.
  assert.equal(parseRetryAfterMs(response({ 'retry-after-ms': 'soon', 'retry-after': '2' })), 2000);
  assert.equal(parseRetryAfterMs(response({ 'retry-after-ms': '-5', 'retry-after': '3' })), 3000);
});

test('retry-after keeps its previous behaviour', () => {
  assert.equal(parseRetryAfterMs(response({ 'retry-after': '0' })), 0);
  assert.equal(parseRetryAfterMs(response({ 'retry-after': '7' })), 7000);
  assert.equal(parseRetryAfterMs(response({})), null);
  assert.equal(parseRetryAfterMs(response({ 'retry-after': ' ' })), null);
  assert.equal(parseRetryAfterMs(undefined), null);
  const later = new Date(Date.now() + 10_000).toUTCString();
  const waited = parseRetryAfterMs(response({ 'retry-after': later }));
  assert.ok(waited > 5000 && waited <= 10_000, String(waited));
});

test('errors without an HTTP status are retried by wording; ones with a status are not', () => {
  // Error events inside a 200 stream carry no status.
  assert.equal(isTransientProviderError(new Error('The server had an error. You can retry your request.')), true);
  assert.equal(isTransientProviderError(Object.assign(new Error('Oops'), { body: { error: { type: 'server_error' } } })), true);
  assert.equal(isTransientProviderError(new Error('Provider returned error')), true);
  assert.equal(isTransientProviderError(new Error('Service Unavailable')), true);
  assert.equal(isTransientProviderError(new Error('Timeout')), true);
  // Unchanged behaviour.
  assert.equal(isTransientProviderError(Object.assign(new Error('Bad gateway'), { statusCode: 502 })), true);
  assert.equal(isTransientProviderError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isTransientProviderError(new Error('fetch failed')), true);
  assert.equal(isTransientProviderError(new Error('Invalid request body')), false);
  assert.equal(isTransientProviderError(new Error('Provider returned non-JSON response')), false);
  // A definite HTTP verdict wins over wording.
  assert.equal(isTransientProviderError(Object.assign(new Error('Internal error in field "tools"'), { statusCode: 400 })), false);
  assert.equal(isTransientProviderError(Object.assign(new Error('Invalid API key'), { statusCode: 401 })), false);
  // A cancelled request is never retried.
  const controller = new AbortController();
  controller.abort();
  assert.equal(isTransientProviderError(new Error('Service Unavailable'), controller.signal), false);
});
