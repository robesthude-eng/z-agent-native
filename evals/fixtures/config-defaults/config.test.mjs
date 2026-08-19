import assert from 'node:assert/strict';
import test from 'node:test';
import { timeoutMs } from './config.js';
test('defaults to 30000ms', () => assert.equal(timeoutMs({}), 30000));
test('keeps explicit timeout', () => assert.equal(timeoutMs({ APP_TIMEOUT_MS: '1250' }), 1250));
