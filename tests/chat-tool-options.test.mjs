import assert from 'node:assert/strict';
import test from 'node:test';
import { assertChatToolAllowed, filterChatTools, normalizeChatToolOptions } from '../server/native/chat-tool-options.mjs';

test('search preference defaults to existing server behavior', () => {
  assert.deepEqual(normalizeChatToolOptions(), { webSearch: true });
});
test('search preference accepts only boolean restrictions', () => {
  for (const value of [false, [], 'true', { webSearch: 'false' }, { webSearch: 0 }])
    assert.throws(() => normalizeChatToolOptions(value), { statusCode: 400 });
});
test('off removes only websearch and cannot add server-disabled tools', () => {
  const tools = [{ name: 'read' }, { name: 'websearch' }, { name: 'webfetch' }];
  assert.deepEqual(
    filterChatTools(tools, { webSearch: false }).map((t) => t.name),
    ['read', 'webfetch'],
  );
  assert.deepEqual(filterChatTools([{ name: 'read' }], { webSearch: true }), [{ name: 'read' }]);
});
test('fabricated model search calls are rejected when disabled', () => {
  assert.throws(() => assertChatToolAllowed('WEBSEARCH', { webSearch: false }));
  assert.doesNotThrow(() => assertChatToolAllowed('read', { webSearch: false }));
});
