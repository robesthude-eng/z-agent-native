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

test('production deploy is gated by successful CI and pins the verified SHA', () => {
  const deploy = source('.github/workflows/deploy.yml');
  assert.match(deploy, /workflow_run:/);
  assert.match(deploy, /workflows:\s*\n\s*- CI/);
  assert.match(deploy, /workflow_run\.conclusion == 'success'/);
  assert.match(deploy, /workflow_run\.head_branch == 'main'/);
  assert.match(deploy, /ref:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(deploy, /DEPLOY_SHA:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(deploy, /LATEST_SHA=.*origin\/main/);
  assert.doesNotMatch(deploy, /\n\s*push:\s*\n/);
});
