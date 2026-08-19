import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueInOrder } from './dedupe.js';

test('removes duplicates without changing first-seen order', () => {
  assert.deepEqual(uniqueInOrder(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
});
