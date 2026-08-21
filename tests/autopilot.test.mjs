import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fallbackEligible,
  rankModelCandidates,
  runFallbackPlan,
  taskStepBudget,
} from '../server/native/autopilot.mjs';
import { formatProjectContext, workspaceFingerprint } from '../server/native/project-context.mjs';

test('Autopilot keeps explicit choice first and otherwise prefers healthy live models', () => {
  const models = [
    { providerID: 'a', modelID: 'alpha', status: 'live' },
    { providerID: 'b', modelID: 'beta', status: 'live' },
    { providerID: 'c', modelID: 'gamma', status: 'cache' },
  ];
  const health = {
    'a/alpha': { successes: 1, failures: 5, consecutiveFailures: 3, lastFailureAt: Date.now() },
    'b/beta': { successes: 20, failures: 0, consecutiveFailures: 0, lastSuccessAt: Date.now() },
  };
  const automatic = rankModelCandidates(models, null, health, null, 'Большой рефактор проекта');
  assert.equal(`${automatic[0].providerID}/${automatic[0].modelID}`, 'b/beta');

  const explicit = rankModelCandidates(models, { providerID: 'a', modelID: 'alpha' }, health, null, 'Большой рефактор проекта');
  assert.equal(`${explicit[0].providerID}/${explicit[0].modelID}`, 'a/alpha');
});

test('fallback switches providers after a transient failure before visible output', async () => {
  const calls = [];
  const plan = {
    explicit: false,
    candidates: [
      { providerID: 'a', modelID: 'one' },
      { providerID: 'b', modelID: 'two' },
    ],
  };
  const result = await runFallbackPlan(plan, { onTextDelta() {} }, async (model) => {
    calls.push(`${model.providerID}/${model.modelID}`);
    if (model.providerID === 'a') throw Object.assign(new Error('rate limited'), { statusCode: 429 });
    return { text: 'ok', toolCalls: [] };
  });
  assert.deepEqual(calls, ['a/one', 'b/two']);
  assert.equal(result.text, 'ok');
  assert.equal(result.attempts.length, 2);
});

test('fallback never mixes two models after the first visible token', async () => {
  let secondCalled = false;
  let visible = '';
  const plan = {
    explicit: false,
    candidates: [
      { providerID: 'a', modelID: 'one' },
      { providerID: 'b', modelID: 'two' },
    ],
  };
  await assert.rejects(
    runFallbackPlan(plan, { onTextDelta(delta) { visible += delta; } }, async (model, request) => {
      if (model.providerID === 'b') secondCalled = true;
      request.onTextDelta?.('partial');
      throw Object.assign(new Error('stream broke'), { statusCode: 503 });
    }),
    /stream broke/,
  );
  assert.equal(visible, 'partial');
  assert.equal(secondCalled, false);
});

test('strict explicit model only falls back for transient failures', () => {
  assert.equal(fallbackEligible(Object.assign(new Error('auth'), { statusCode: 401 }), { strict: true }), false);
  assert.equal(fallbackEligible(Object.assign(new Error('rate'), { statusCode: 429 }), { strict: true }), true);
  assert.equal(fallbackEligible(Object.assign(new Error('server'), { statusCode: 503 }), { strict: true }), true);
  assert.equal(fallbackEligible(new Error('Client network socket disconnected before secure TLS connection was established'), { strict: true }), true);
  assert.equal(fallbackEligible(Object.assign(new Error('user stop'), { name: 'AbortError' }), { strict: true }), false);
  assert.equal(fallbackEligible(Object.assign(new Error('bad request'), { statusCode: 400 }), { strict: true }), false);
  assert.equal(fallbackEligible(Object.assign(new Error('Free promotion has ended for DeepSeek V4 Flash Free. You can continue using the model by subscribing to OpenCode Go - https://opencode.ai/go'), { statusCode: 400 }), { strict: true }), true);
  assert.equal(fallbackEligible(Object.assign(new Error('payment required'), { statusCode: 402 }), { strict: true }), true);
});

test('fallback switches away from an ended free-model SKU before visible output', async () => {
  const calls = [];
  const plan = {
    explicit: false,
    candidates: [
      { providerID: 'a', modelID: 'deepseek-v4-flash-free' },
      { providerID: 'b', modelID: 'coder' },
    ],
  };
  const result = await runFallbackPlan(plan, { onTextDelta() {} }, async (model) => {
    calls.push(`${model.providerID}/${model.modelID}`);
    if (model.providerID === 'a') {
      throw Object.assign(new Error('Free promotion has ended for DeepSeek V4 Flash Free'), { statusCode: 400 });
    }
    return { text: 'ok', toolCalls: [] };
  });
  assert.deepEqual(calls, ['a/deepseek-v4-flash-free', 'b/coder']);
  assert.equal(result.text, 'ok');
});

test('long tasks receive a larger bounded autonomous step budget', () => {
  assert.equal(taskStepBudget('Поменяй один текст', ''), 36);
  assert.ok(taskStepBudget('Полностью проведи архитектурную миграцию во всём репозитории и проверь production build', '') >= 52);
  assert.equal(taskStepBudget('anything', '17'), 17);
  assert.equal(taskStepBudget('anything', '999'), 128);
});

test('persistent project fingerprint changes when workspace state changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-project-context-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    const first = workspaceFingerprint(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one-two-three');
    const second = workspaceFingerprint(root);
    assert.notEqual(first, second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persistent context carries repository map and recent completed work', () => {
  const text = formatProjectContext({
    repoMap: 'src/index.ts -> src/runtime.ts',
    turns: [{ goal: 'Исправить runtime', outcome: 'completed', model: 'p/m', changed: true, summary: 'Исправлена проверка.' }],
  });
  assert.match(text, /Persistent project context/);
  assert.match(text, /src\/index\.ts/);
  assert.match(text, /Recent completed work/);
  assert.match(text, /Исправить runtime/);
});

test('agent runtime is wired to Autopilot and persistent project context', () => {
  const agentSource = fs.readFileSync(new URL('../server/native/agent.mjs', import.meta.url), 'utf8');
  const subagentSource = fs.readFileSync(new URL('../server/native/subagent-runner.mjs', import.meta.url), 'utf8');
  assert.match(agentSource, /buildModelPlan/);
  assert.match(agentSource, /callModelAutopilot/);
  assert.match(agentSource, /getProjectContext/);
  assert.match(agentSource, /rememberProjectTurn/);
  assert.match(agentSource, /taskStepBudget/);
  assert.match(agentSource, /runSubagent/);
  assert.match(subagentSource, /subagentStepBudget/);
  assert.match(subagentSource, /callModelAutopilot/);
});
