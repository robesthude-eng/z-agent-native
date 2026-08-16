import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function source(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('native runtime has no browser permission-response protocol', () => {
  const agent = source('server/native/agent.mjs');
  const index = source('server/index.mjs');

  assert.doesNotMatch(agent, /permissionWaiters|answerPermission|requestPermission|requiresPermission|createPermission|getPermission|resolvePermission/);
  assert.doesNotMatch(index, /answerPermission|\/permissions\//);
});

test('autonomy presentation no longer installs a global MutationObserver', () => {
  const ux = source('src/lib/autonomyUx.ts');
  assert.doesNotMatch(ux, /new\s+MutationObserver|\.observe\(document\.documentElement/);
});

test('assistant replies expose exact turn result action', () => {
  const item = source('src/components/MessageItem.tsx');
  const modal = source('src/components/TurnResultModal.tsx');
  assert.match(item, /TurnResultButton/);
  assert.match(modal, /Откатить весь ход/);
  assert.match(modal, /более поздняя задача изменила/);
});
