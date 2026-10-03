import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function source(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

// Видимый текст интерфейса живёт в каталоге src/i18n/ru.ts, а в компонентах
// остаются только ключи. Подставляем значения ключей, чтобы контрактные
// проверки шли по тому, что реально увидит пользователь.
const uiMessages = source('src/i18n/ru.ts');

function renderUi(code) {
  return code.replace(/\bt\("([a-z0-9_.]+)"\)/g, (match, key) => {
    const entry = uiMessages.match(
      new RegExp('"' + key.replace(/\./g, '\\.') + '":\\s*"([^"]*)"'),
    );
    return entry ? entry[1] : match;
  });
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
  const modal = renderUi(source('src/components/TurnResultModal.tsx'));
  assert.match(item, /TurnResultButton/);
  assert.match(modal, /Откатить весь ход/);
  assert.match(modal, /более поздняя задача\s+изменила/);
});

test('CI boots the production compose topology and requires readiness before deploy can succeed', () => {
  const ci = source('.github/workflows/ci.yml');
  assert.match(ci, /Boot production topology and require full readiness/);
  assert.match(ci, /docker compose up -d --no-build --remove-orphans/);
  assert.match(ci, /Publish exactly-tested images by commit/);
  assert.match(ci, /production-images\.env/);
  assert.match(ci, /RepoDigests/);
  assert.match(ci, /127\.0\.0\.1:3002\/health\/ready/);
  assert.match(ci, /z-agent-executor[\s\S]*z-agent-browser[\s\S]*z-agent-browser-egress/);
  assert.match(ci, /docker compose down -v --remove-orphans/);
});

