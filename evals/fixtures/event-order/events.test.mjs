import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptEvent } from './events.js';
test('duplicate sequence is ignored', () => {
  const state = { seq: 4, text: 'a' };
  assert.deepEqual(acceptEvent(state, { seq: 4, delta: 'b' }), state);
});
