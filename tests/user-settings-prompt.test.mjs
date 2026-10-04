import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserSettingsPrompt, userSettingsFrom } from '../server/native/user-settings-prompt.mjs';

test('empty settings add nothing to the prompt', () => {
  assert.equal(buildUserSettingsPrompt({}), '');
  assert.equal(buildUserSettingsPrompt({ responseStyle: 'default', responseLanguage: 'auto', customInstructions: '  ' }), '');
});

test('style, language and custom instructions are rendered', () => {
  const p = buildUserSettingsPrompt({ responseStyle: 'concise', responseLanguage: 'ru', customInstructions: 'Обращайся на ты' });
  assert.match(p, /Owner preferences/);
  assert.match(p, /concisely/);
  assert.match(p, /Russian/);
  assert.match(p, /Обращайся на ты/);
});

test('custom instructions are capped and prefs envelope is unwrapped', () => {
  const p = buildUserSettingsPrompt({ customInstructions: 'x'.repeat(10_000) });
  assert.ok(p.length < 4200);
  assert.deepEqual(userSettingsFrom({ appSettings: { value: { a: 1 }, updatedAt: 1 } }), { a: 1 });
  assert.deepEqual(userSettingsFrom({}), {});
});
