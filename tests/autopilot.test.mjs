import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildModelPlan,
  fallbackEligible,
  lockedModelMessage,
  modelFailureReason,
  modelKey,
  promoteModelPlan,
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
  assert.equal(fallbackEligible(Object.assign(new Error('Error from provider (Console): Upstream request failed: Model is unavailable.'), { statusCode: 400 }), { strict: true }), true);
  assert.equal(fallbackEligible(Object.assign(new Error('{"model":"mimo-v2.5-free"}'), { statusCode: 400 }), { strict: true }), true);
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

test('каждой попытке сообщается, какая именно модель отвечает', async () => {
  const prompts = [];
  const plan = { explicit: true, expandOnFailure: false, candidates: [{ providerID: 'zai', modelID: 'glm-5.3' }] };
  const result = await runFallbackPlan(plan, { system: 'BASE PROMPT' }, async (_model, request) => {
    prompts.push(request.system);
    return { text: 'ok' };
  });
  assert.equal(result.model.modelID, 'glm-5.3');
  assert.ok(prompts[0].startsWith('BASE PROMPT'), 'базовый промпт сохраняется');
  assert.match(prompts[0], /zai\/glm-5\.3/);
  assert.match(prompts[0], /provider id "zai"/);
});

test('при переходе на резервную модель строка идентичности обновляется', async () => {
  const prompts = [];
  const plan = {
    candidates: [
      { providerID: 'zai', modelID: 'glm-5.3' },
      { providerID: 'openai', modelID: 'gpt-5' },
    ],
  };
  const result = await runFallbackPlan(plan, { system: 'BASE' }, async (model, request) => {
    prompts.push(request.system);
    if (model.modelID === 'glm-5.3') throw Object.assign(new Error('rate limited'), { statusCode: 429 });
    return { text: 'ok' };
  });
  assert.equal(result.model.modelID, 'gpt-5');
  assert.match(prompts[0], /zai\/glm-5\.3/);
  assert.match(prompts[1], /openai\/gpt-5/);
  assert.ok(!prompts[1].includes('zai/glm-5.3'), 'резервная модель не представляется чужим именем');
});

test('выбранная вручную модель никогда не подменяется другой', async () => {
  const plan = await buildModelPlan('owner-locked', { providerID: 'zai', modelID: 'glm-5.3' }, 'вопрос');
  assert.equal(plan.locked, true, 'явный выбор закрепляется');
  assert.equal(plan.expandOnFailure, false, 'план не расширяется резервными моделями');
  assert.deepEqual(plan.candidates.map(modelKey), ['zai/glm-5.3']);

  // Даже если рядом лежит годный кандидат, locked-план его не трогает.
  const tried = [];
  await assert.rejects(
    runFallbackPlan(
      { ...plan, candidates: [...plan.candidates, { providerID: 'openai', modelID: 'gpt-5' }] },
      { system: 'BASE' },
      async (model) => {
        tried.push(modelKey(model));
        throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      },
    ),
    (err) => {
      assert.equal(err.modelLocked, true);
      assert.equal(err.lockedModel, 'zai/glm-5.3');
      assert.match(err.publicMessage, /zai\/glm-5\.3/);
      assert.match(err.publicMessage, /лимит/i);
      return true;
    },
  );
  assert.deepEqual(tried, ['zai/glm-5.3'], 'вторая модель не вызывается');
});

test('в режиме «Авто» агент по-прежнему сам берёт следующую модель', async () => {
  const plan = {
    explicit: false,
    locked: false,
    candidates: [
      { providerID: 'zai', modelID: 'glm-5.3' },
      { providerID: 'openai', modelID: 'gpt-5' },
    ],
  };
  const result = await runFallbackPlan(plan, { system: 'BASE' }, async (model) => {
    if (model.modelID === 'glm-5.3') throw Object.assign(new Error('rate limited'), { statusCode: 429 });
    return { text: 'ok' };
  });
  assert.equal(modelKey(result.model), 'openai/gpt-5');
});

test('locked-план остаётся закреплённым на всех шагах хода', () => {
  const plan = {
    candidates: [{ providerID: 'zai', modelID: 'glm-5.3' }],
    explicit: true,
    locked: true,
    expandOnFailure: false,
  };
  const promoted = promoteModelPlan(plan, { providerID: 'zai', modelID: 'glm-5.3' });
  assert.equal(promoted.locked, true);
  assert.equal(promoted.expandOnFailure, false);
  assert.deepEqual(promoted.candidates.map(modelKey), ['zai/glm-5.3']);

  // Авто-план после выбора модели замок не получает.
  const auto = promoteModelPlan(
    { candidates: [{ providerID: 'zai', modelID: 'glm-5.3' }, { providerID: 'openai', modelID: 'gpt-5' }], locked: false },
    { providerID: 'openai', modelID: 'gpt-5' },
  );
  assert.equal(auto.locked, false);
  assert.equal(modelKey(auto.candidates[0]), 'openai/gpt-5');
});

test('причина отказа выбранной модели объясняется человеческим языком', () => {
  const cases = [
    [Object.assign(new Error('Insufficient balance'), { statusCode: 402 }), /баланс|квота/i],
    [Object.assign(new Error('model not found'), { statusCode: 404 }), /не знает|не существует/i],
    [Object.assign(new Error('unauthorized'), { statusCode: 401 }), /API key|доступ/i],
    [Object.assign(new Error('rate limit'), { statusCode: 429 }), /лимит/i],
    [Object.assign(new Error('bad gateway'), { statusCode: 502 }), /сервера/i],
  ];
  for (const [error, expected] of cases) assert.match(modelFailureReason(error), expected);

  const text = lockedModelMessage(
    { providerID: 'zai', modelID: 'glm-5.3' },
    Object.assign(new Error('Insufficient balance'), { statusCode: 402 }),
  );
  assert.match(text, /Модель «zai\/glm-5\.3»/);
  assert.match(text, /баланс/i);
  assert.match(text, /Авто/, 'подсказываем, где включается автовыбор');
  assert.doesNotMatch(text, /возьмёт другую/i, 'никаких обещаний взять другую модель');
});

test('замок модели соблюдается во всей цепочке: рантайм, чат и перезапуск', () => {
  const read = (file) => fs.readFileSync(new URL(`../server/native/${file}`, import.meta.url), 'utf8');
  const autopilotSource = read('autopilot.mjs');
  const agentSource = read('agent.mjs');
  const providersSource = read('providers.mjs');
  const durableSource = read('durable-jobs.mjs');

  assert.match(autopilotSource, /!plan\?\.locked/, 'расширение плана закрыто для locked');
  assert.match(autopilotSource, /lockedModelMessage/);
  assert.match(agentSource, /err\?\.modelLocked/, 'текст отказа доезжает в чат как есть');
  assert.match(agentSource, /mode: modelLocked \? 'locked' : 'auto'/, 'в ленте виден режим выбора модели');
  assert.match(providersSource, /err\?\.publicMessage/, 'готовое объяснение не маскируется');
  assert.match(durableSource, /locked: Boolean\(plan\.locked\)/, 'замок выживает перезапуск');
});
