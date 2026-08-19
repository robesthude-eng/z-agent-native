import assert from 'node:assert/strict';
import test from 'node:test';
import { increment } from './counter.js';
test('increments by one', () => assert.equal(increment(4), 5));
