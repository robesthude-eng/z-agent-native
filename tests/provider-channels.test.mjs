import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-provider-channels-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const configs = await import('../server/native/provider-configs.mjs');
const providers = await import('../server/native/providers.mjs');
const { handleProviderChannels, listProviderChannels } = await import('../server/native/provider-channels.mjs');

const ownerA = 'provider-a@example.com';
const ownerB = 'provider-b@example.com';
const ownerEmpty = 'provider-empty@example.com';
store.createUser(ownerA, 'test-hash');
store.createUser(ownerB, 'test-hash');
store.createUser(ownerEmpty, 'test-hash');

function captureResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = String(body || ''); },
  };
}

// readJson() читает запрос как поток, поэтому тестовый request должен быть
// async-iterable, а не просто объектом с полем body.
function jsonRequest(method, body) {
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  return {
    method,
    async *[Symbol.asyncIterator]() { yield payload; },
  };
}

async function call(method, pathname, body, ownerId) {
  const res = captureResponse();
  const handled = await handleProviderChannels(
    body === undefined ? { method } : jsonRequest(method, body),
    res,
    ownerId,
    new URL("http://localhost" + pathname),
  );
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

function connectedChannel(ownerId, name, { key = 'secret-key', enabled = true } = {}) {
  const id = configs.newCustomProviderId();
  configs.upsertProviderConfig(ownerId, {
    id, name, protocol: 'openai', baseURL: 'https://models.example.com/v1', enabled,
  });
  if (key) store.setProviderKey(ownerId, id, key);
  return id;
}

test('provider management starts empty until the user adds a channel', () => {
  assert.deepEqual(providers.providerSpecs(ownerEmpty), {});
  assert.deepEqual(listProviderChannels(ownerEmpty), []);
});

test('custom provider channels are owner-scoped and merged into the runtime registry', () => {
  const id = configs.newCustomProviderId();
  configs.upsertProviderConfig(ownerA, {
    id,
    name: 'My OpenAI Channel',
    protocol: 'openai',
    baseURL: 'https://models.example.com/v1',
    enabled: true,
  }, { custom: true });

  const a = providers.providerSpecs(ownerA)[id];
  const b = providers.providerSpecs(ownerB)[id];
  assert.equal(a.name, 'My OpenAI Channel');
  assert.equal(a.kind, 'openai');
  assert.equal(a.baseURL, 'https://models.example.com/v1');
  assert.equal(a.custom, true);
  assert.equal(a.trustedBaseURL, false);
  assert.equal(b, undefined);
  assert.deepEqual(listProviderChannels(ownerB), []);
  assert.deepEqual(listProviderChannels(ownerA).map((item) => item.id), [id]);
});

test('legacy configured built-in ids are treated as user-owned channels, not templates', () => {
  configs.upsertProviderConfig(ownerB, {
    id: 'openai',
    name: 'My Relay',
    protocol: 'openai',
    baseURL: 'https://relay.example.com/openai/v1',
    enabled: true,
  }, { custom: false });

  const channels = listProviderChannels(ownerB);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, 'openai');
  assert.equal(channels[0].name, 'My Relay');
  assert.equal(channels[0].custom, true);
  assert.equal(channels[0].overridden, false);
});

test('provider channel HTTP handler returns only saved channels', async () => {
  const res = captureResponse();
  const handled = await handleProviderChannels(
    { method: 'GET' },
    res,
    ownerEmpty,
    new URL('http://localhost/api/provider-channels'),
  );
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.providers, []);
});

test('provider config validation rejects unsafe shapes', () => {
  assert.throws(() => configs.upsertProviderConfig(ownerA, {
    id: 'bad-provider', name: 'Bad', protocol: 'unknown', baseURL: 'https://example.com', enabled: true,
  }), /Протокол/);
  assert.throws(() => configs.upsertProviderConfig(ownerA, {
    id: 'bad-provider', name: 'Bad', protocol: 'openai', baseURL: 'file:///tmp/model', enabled: true,
  }), /HTTP/);
  assert.throws(() => configs.upsertProviderConfig(ownerA, {
    id: 'bad-provider', name: 'Bad', protocol: 'openai', baseURL: 'http://models.example.com/v1', enabled: true,
  }), /HTTPS/);
  assert.throws(() => configs.upsertProviderConfig(ownerA, {
    id: 'bad-provider', name: 'Bad', protocol: 'openai', baseURL: 'https://user:pass@example.com/v1', enabled: true,
  }), /логина\/пароля/);
});

test('manual model flags survive an enable/disable toggle from settings', async () => {
  const id = connectedChannel(ownerA, 'Flags');

  const created = await call('POST', `/api/provider-channels/${id}/manual-models`,
    { modelId: 'free-model', name: 'Free Model', isFree: true, probe: false }, ownerA);
  assert.equal(created.status, 200);
  const [saved] = store.listManualModels(ownerA, id);
  assert.equal(saved.is_free, true);
  assert.equal(saved.enabled, true);
  assert.equal(saved.name, 'Free Model');

  // Переключатель видимости шлёт только enabled, и это не должно
  // обнулять название и флаг «бесплатная».
  const toggled = await call('POST', `/api/provider-channels/${id}/manual-models`,
    { modelId: 'free-model', enabled: false, probe: false }, ownerA);
  assert.equal(toggled.status, 200);
  const [afterToggle] = store.listManualModels(ownerA, id);
  assert.equal(afterToggle.enabled, false);
  assert.equal(afterToggle.is_free, true);
  assert.equal(afterToggle.name, 'Free Model');

  const listed = await call('GET', `/api/provider-channels/${id}/manual-models`, undefined, ownerA);
  assert.equal(listed.body.models[0].enabled, false);
  assert.equal(listed.body.models[0].is_free, true);
});

test('manual model flags reach the model picker catalog', async () => {
  const owner = 'provider-catalog@example.com';
  store.createUser(owner, 'test-hash');
  // Канал без ключа: сетевой каталог не запрашивается, а ручные модели видны.
  const id = connectedChannel(owner, 'Picker', { key: null });
  await call('POST', `/api/provider-channels/${id}/manual-models`, { modelId: 'shown', isFree: true, probe: false }, owner);
  await call('POST', `/api/provider-channels/${id}/manual-models`, { modelId: 'muted', enabled: false, probe: false }, owner);

  const catalog = await providers.buildCatalog(owner, { force: false });
  const rows = catalog.models.filter((model) => model.sourceProviderID === id);
  assert.deepEqual(rows.map((model) => model.modelID), ['shown']);
  assert.equal(rows[0].free, true);
});

test('a refresh names manual models the provider no longer lists', async () => {
  const owner = 'provider-missing@example.com';
  store.createUser(owner, 'test-hash');
  // Base URL — литеральный IP: проверка адреса идёт до подмены транспорта,
  // а DNS в тестовой песочнице недоступен.
  const id = configs.newCustomProviderId();
  configs.upsertProviderConfig(owner, {
    id, name: 'Zen', protocol: 'openai', baseURL: 'https://1.1.1.1/zen/v1', enabled: true,
  });
  store.setProviderKey(owner, id, 'secret-key');
  await call('POST', `/api/provider-channels/${id}/manual-models`,
    { modelId: 'deepseek-v3-free', probe: false }, owner);

  // Провайдер заменил бесплатную модель на другую.
  providers.setProviderTransportForTests(async () => new Response(
    JSON.stringify({ data: [{ id: 'minimax-m2.6-free', name: 'MiniMax M2.6 Free' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    const refreshed = await call('POST', `/api/provider-channels/${id}/refresh`, {}, owner);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.status, 'live');
    assert.deepEqual(refreshed.body.models.map((model) => model.id), ['minimax-m2.6-free']);
    // Старая ручная модель осталась в выборе моделей, и об этом говорят вслух.
    assert.deepEqual(refreshed.body.missingManual, ['deepseek-v3-free']);
  } finally {
    providers.setProviderTransportForTests(null);
  }
});

test('manual model probe checks without saving and never leaks provider internals', async () => {
  const id = connectedChannel(ownerA, 'Probe', { key: null });

  const missing = await call('POST', '/api/provider-channels/does-not-exist/manual-models/probe', { modelId: 'x' }, ownerA);
  assert.equal(missing.status, 404);

  const empty = await call('POST', `/api/provider-channels/${id}/manual-models/probe`, { modelId: '   ' }, ownerA);
  assert.equal(empty.status, 400);

  const probed = await call('POST', `/api/provider-channels/${id}/manual-models/probe`, { modelId: 'ghost-model' }, ownerA);
  assert.equal(probed.status, 200);
  assert.equal(probed.body.available, false);
  assert.ok(probed.body.error);
  assert.doesNotMatch(probed.body.error, /https?:\/\//);
  // Проверка ничего не сохраняет.
  assert.deepEqual(store.listManualModels(ownerA, id), []);
});

test('hidden models are validated and scoped to an existing channel', async () => {
  const id = connectedChannel(ownerA, 'Hidden');

  const unknown = await call('POST', '/api/provider-channels/no-such-provider/hidden-models', { modelId: 'm', hidden: true }, ownerA);
  assert.equal(unknown.status, 404);

  const blank = await call('POST', `/api/provider-channels/${id}/hidden-models`, { modelId: '', hidden: true }, ownerA);
  assert.equal(blank.status, 400);
  assert.deepEqual(store.listHiddenModels(ownerA, id), []);

  const tooLong = await call('POST', `/api/provider-channels/${id}/hidden-models`, { modelId: 'm'.repeat(201), hidden: true }, ownerA);
  assert.equal(tooLong.status, 400);

  const hide = await call('POST', `/api/provider-channels/${id}/hidden-models`, { modelId: 'model-1', hidden: true }, ownerA);
  assert.equal(hide.status, 200);
  const listed = await call('GET', `/api/provider-channels/${id}/hidden-models`, undefined, ownerA);
  assert.deepEqual(listed.body.hidden, ['model-1']);

  await call('POST', `/api/provider-channels/${id}/hidden-models`, { modelId: 'model-1', hidden: false }, ownerA);
  assert.deepEqual(store.listHiddenModels(ownerA, id), []);
});

test('deleting a manual model requires an id', async () => {
  const id = connectedChannel(ownerA, 'Delete guard');
  await call('POST', `/api/provider-channels/${id}/manual-models`, { modelId: 'keep-me', probe: false }, ownerA);

  const blank = await call('DELETE', `/api/provider-channels/${id}/manual-models`, {}, ownerA);
  assert.equal(blank.status, 400);
  assert.equal(store.listManualModels(ownerA, id).length, 1);

  const removed = await call('DELETE', `/api/provider-channels/${id}/manual-models`, { modelId: 'keep-me' }, ownerA);
  assert.equal(removed.status, 200);
  assert.deepEqual(store.listManualModels(ownerA, id), []);
});

test('saving a channel reports disabled and missing-key states separately', async () => {
  const off = await call('POST', '/api/provider-channels', {
    name: 'Turned off', protocol: 'openai', baseURL: 'https://off.example.com/v1', enabled: false,
  }, ownerA);
  assert.equal(off.status, 200);
  // Раньше выключенный канал без ключа отвечал unauthorized и UI просил ключ.
  assert.equal(off.body.catalog.status, 'disabled');

  const on = await call('POST', '/api/provider-channels', {
    name: 'No key yet', protocol: 'openai', baseURL: 'https://nokey.example.com/v1', enabled: true,
  }, ownerA);
  assert.equal(on.body.catalog.status, 'unauthorized');
});

test('deleting a provider removes its key and model state atomically', () => {
  const id = configs.newCustomProviderId();
  configs.upsertProviderConfig(ownerA, {
    id, name: 'Disposable', protocol: 'anthropic', baseURL: 'https://anthropic.example.com/v1', enabled: true,
  });
  store.setProviderKey(ownerA, id, 'secret-key');
  store.upsertManualModel(ownerA, id, { modelId: 'model-1', enabled: true });
  store.setHiddenModel(ownerA, id, 'model-2', true);

  configs.deleteProviderConfig(ownerA, id, { deleteData: true });
  assert.equal(configs.getProviderConfig(ownerA, id), null);
  assert.equal(store.getProviderKey(ownerA, id), null);
  assert.deepEqual(store.listManualModels(ownerA, id), []);
  assert.deepEqual(store.listHiddenModels(ownerA, id), []);
});
