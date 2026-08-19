import assert from 'node:assert/strict';
import test from 'node:test';
import { inside } from './path.js';
test('sibling prefix is outside', () => assert.equal(inside('/tmp/work', '../workspace-evil'), false));
test('nested path is inside', () => assert.equal(inside('/tmp/work', 'src/a.js'), true));
