import assert from 'node:assert/strict';
import test from 'node:test';
import { Cache } from './cache.js';
test('failed loads can be retried', async () => {
  const cache = new Cache();
  let calls = 0;
  await assert.rejects(() => cache.get('x', async () => { calls += 1; throw new Error('boom'); }));
  assert.equal(await cache.get('x', async () => { calls += 1; return 42; }), 42);
  assert.equal(calls, 2);
});
