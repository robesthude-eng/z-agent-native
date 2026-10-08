import assert from 'node:assert/strict';
import test from 'node:test';

const { pickLightModel, isLightModelId, lightModelPlan, resetLightModelCacheForTests } = await import('../server/native/light-model.mjs');

const m = (providerID, modelID, status = 'live') => ({ providerID, modelID, modelName: modelID, status });

test('light-model detection by name: small tiers yes, big/reasoning/non-text no', () => {
  for (const id of [
    'gpt-4o-mini',
    'gpt-5-nano',
    'claude-3-5-haiku-latest',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'mistral-small-latest',
    'llama-3.1-8b-instant',
    'qwen2.5-7b-instruct',
  ])
    assert.equal(isLightModelId(id), true, id);
  for (const id of [
    'gpt-4o',
    'claude-opus-4',
    'claude-sonnet-4',
    'gemini-2.5-pro',
    'o3-mini-reasoning',
    'deepseek-r1',
    'gemini-2.5-flash-image',
    'text-embedding-3-small',
    'gpt-4o-mini-tts',
    'whisper-1',
    'gemini-ultra',
    'deepseek-chat',
  ])
    assert.equal(isLightModelId(id), false, id);
  assert.equal(isLightModelId('gemini-pro'), false, '"gemini" contains "mini" but is not a mini model');
});

test('pickLightModel stays inside the chat provider, ignores broken models and the primary itself', () => {
  const models = [
    m('openai', 'gpt-4o'),
    m('openai', 'gpt-4o-mini'),
    m('openai', 'gpt-5-nano'),
    m('openai', 'gpt-4.1-mini', 'error'),
    m('anthropic', 'claude-3-5-haiku-latest'),
  ];
  assert.equal(pickLightModel(models, { providerID: 'openai', modelID: 'gpt-4o' }).modelID, 'gpt-5-nano', 'nano beats mini');
  assert.equal(pickLightModel(models, { providerID: 'anthropic', modelID: 'claude-sonnet-4' }).modelID, 'claude-3-5-haiku-latest');
  assert.equal(pickLightModel(models, { providerID: 'openai', modelID: 'gpt-4o-mini' }), null, 'chat is already on a light model');
  assert.equal(pickLightModel(models, { providerID: 'other', modelID: 'big' }), null, 'never crosses providers');
  assert.equal(pickLightModel([], { providerID: 'openai', modelID: 'x' }), null);
  assert.equal(pickLightModel(models, null), null);
});

test('lightModelPlan puts the light model first and keeps the chat model as fallback; failures return the original plan', async () => {
  resetLightModelCacheForTests();
  const plan = { candidates: [{ providerID: 'openai', modelID: 'gpt-4o' }], locked: true, explicit: true };
  const catalog = async () => ({ models: [m('openai', 'gpt-4o'), m('openai', 'gpt-4o-mini')] });
  const light = await lightModelPlan('o@example.com', plan, { catalog });
  assert.deepEqual(
    light.candidates.map((c) => c.modelID),
    ['gpt-4o-mini', 'gpt-4o'],
  );
  assert.equal(light.locked, false, 'fallback to the chat model is allowed in the background');
  assert.equal(plan.locked, true, 'the original plan is not mutated');
  resetLightModelCacheForTests();
  assert.equal(await lightModelPlan('o@example.com', plan, { catalog: async () => Promise.reject(new Error('down')) }), plan);
  const empty = { candidates: [] };
  assert.equal(await lightModelPlan('o@example.com', empty), empty);
});

test('lightModelPlan: the catalog is cached per owner/model and Z_AGENT_LIGHT_MODEL overrides or disables', async () => {
  resetLightModelCacheForTests();
  let lookups = 0;
  const catalog = async () => {
    lookups++;
    return { models: [m('openai', 'gpt-4o'), m('openai', 'gpt-4o-mini')] };
  };
  const plan = { candidates: [{ providerID: 'openai', modelID: 'gpt-4o' }] };
  await lightModelPlan('c@example.com', plan, { catalog });
  await lightModelPlan('c@example.com', plan, { catalog });
  assert.equal(lookups, 1);
  try {
    process.env.Z_AGENT_LIGHT_MODEL = 'groq/llama-3.1-8b-instant';
    assert.equal((await lightModelPlan('c@example.com', plan, { catalog })).candidates[0].providerID, 'groq');
    process.env.Z_AGENT_LIGHT_MODEL = 'off';
    assert.equal(await lightModelPlan('c@example.com', plan, { catalog }), plan);
  } finally {
    delete process.env.Z_AGENT_LIGHT_MODEL;
  }
});
