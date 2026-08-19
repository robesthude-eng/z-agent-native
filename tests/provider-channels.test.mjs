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
