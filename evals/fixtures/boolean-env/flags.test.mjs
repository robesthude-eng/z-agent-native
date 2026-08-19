import test from 'node:test';
import assert from 'node:assert/strict';
import { envFlag } from './flags.js';

test('parses common true/false environment spellings', () => {
  assert.equal(envFlag('1'), true);
  assert.equal(envFlag('true'), true);
  assert.equal(envFlag('0'), false);
  assert.equal(envFlag('false'), false);
});

test('uses fallback for empty values', () => {
  assert.equal(envFlag('', true), true);
});
