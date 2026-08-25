import { getProviderKey, listHiddenModels, listManualModels } from '../store.mjs';
import { listProviderConfigs } from '../provider-configs.mjs';
import { assertSafeProviderUrl, fetchJson, providerAuth, wrapProviderUrl } from './transport.mjs';

export const FIXTURE_PROVIDER_ID = 'fixture';
export const FIXTURE_MODEL_ID = 'coding-e2e';

export function fixtureProviderEnabled() {
  return process.env.Z_AGENT_ENABLE_FIXTURE_PROVIDER === '1';
}

function fixtureToolCount(frames, name) {
  return (Array.isArray(frames) ? frames : []).filter((frame) => frame?.role === 'tool' && frame?.name === name && !frame?.isError).length;
}

function fixturePrompt(frames) {
  return (Array.isArray(frames) ? frames : []).filter((frame) => frame?.role === 'user').map((frame) => String(frame?.content || '')).join('\n');
}

export function fixtureResponse(request) {
  if (!fixtureProviderEnabled()) throw Object.assign(new Error('Fixture provider is disabled'), { statusCode: 403 });
  const frames = request?.frames || [];
  const prompt = fixturePrompt(frames);
  const questionDone = fixtureToolCount(frames, 'question') > 0;
  const writeCount = fixtureToolCount(frames, 'write');
  const testsDone = fixtureToolCount(frames, 'run_tests') > 0;
  let response;

  if (/FIXTURE_ASK_USER/i.test(prompt) && !questionDone) {
    response = {
      text: '',
      toolCalls: [{ id: 'fixture_question_1', name: 'question', arguments: { questions: [{ header: 'Fixture', question: 'Continue the deterministic fixture turn?', options: [{ label: 'Continue' }] }] } }],
      finish: 'tool_calls',
    };
  } else if (writeCount < 2) {
    response = {
      text: 'I will create a tiny module and its regression test, then execute the test.',
      toolCalls: [
        { id: 'fixture_write_module', name: 'write', arguments: { path: 'hello.js', content: 'export const hello = () => "hello from fixture";\n' } },
        { id: 'fixture_write_test', name: 'write', arguments: { path: 'hello.test.mjs', content: 'import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport test from "node:test";\nconst source = fs.readFileSync(new URL("./hello.js", import.meta.url), "utf8");\ntest("fixture hello", () => assert.match(source, /hello from fixture/));\n' } },
      ],
      finish: 'tool_calls',
    };
  } else if (!testsDone) {
    response = {
      text: 'The files are written. I am running the exact regression test now.',
      toolCalls: [{ id: 'fixture_run_tests', name: 'run_tests', arguments: { command: 'node --test hello.test.mjs' } }],
      finish: 'tool_calls',
    };
  } else {
    response = {
      text: 'Fixture task completed and verified: hello.js is covered by hello.test.mjs.',
      toolCalls: [],
      finish: 'stop',
    };
  }

  if (typeof request?.onTextDelta === 'function' && response.text) request.onTextDelta(response.text, 'text');
  return { ...response, usage: { prompt_tokens: 16, completion_tokens: 12 }, streamed: typeof request?.onTextDelta === 'function' };
}

export const builtInSpecs = {};

export function effectiveSpecs(ownerId) {
  const specs = Object.fromEntries(Object.entries(builtInSpecs).map(([id, spec]) => [id, {
    ...spec,
    id,
    enabled: true,
    custom: false,
    trustedBaseURL: true,
  }]));
  if (!ownerId) return specs;
  for (const config of listProviderConfigs(ownerId)) {
    const builtin = builtInSpecs[config.id];
    if (builtin) {
      specs[config.id] = {
        ...builtin,
        id: config.id,
        name: config.name || builtin.name,
        kind: config.protocol || builtin.kind,
        baseURL: config.baseURL || builtin.baseURL,
        enabled: config.enabled,
        custom: false,
        trustedBaseURL: (config.baseURL || builtin.baseURL) === builtin.baseURL,
      };
    } else {
      specs[config.id] = {
        id: config.id,
        name: config.name,
        kind: config.protocol,
        baseURL: config.baseURL,
        enabled: config.enabled,
        custom: true,
        trustedBaseURL: false,
      };
    }
  }
  return specs;
}

const cache = new Map();
const discoveryCache = new Map();
const CACHE_MS = 5 * 60 * 1000;

export function isBuiltInProvider(providerId) {
  return Boolean(builtInSpecs[providerId]);
}

export function providerSpecs(ownerId = null) {
  return effectiveSpecs(ownerId);
}

export function providerList(ownerId = null) {
  const rows = Object.entries(effectiveSpecs(ownerId)).map(([id, spec]) => ({
    id,
    name: spec.name,
    protocol: spec.kind,
    baseURL: spec.baseURL,
    enabled: spec.enabled !== false,
    custom: Boolean(spec.custom),
    models: {},
  }));
  if (fixtureProviderEnabled()) {
    rows.unshift({ id: FIXTURE_PROVIDER_ID, name: 'Deterministic Fixture', protocol: 'fixture', baseURL: '', enabled: true, custom: false, models: {} });
  }
  return rows;
}

function modelListDirectUrl(spec) {
  return `${spec.baseURL.replace(/\/$/, '')}/models`;
}

async function fetchModelList(spec, key) {
  const headers = {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'Z-Agent/1.0',
    ...providerAuth(spec, key),
  };
  const direct = modelListDirectUrl(spec);
  if (!spec.trustedBaseURL) await assertSafeProviderUrl(direct);
  const urls = [...new Set([wrapProviderUrl(direct), direct])].map((url) => ({
    url,
    pinned: !spec.trustedBaseURL || url !== direct,
  }));
  let lastError = null;
  for (const target of urls) {
    try {
      return await fetchJson(target, { headers });
    } catch (err) {
      lastError = err;
      const status = Number(err?.statusCode) || 0;
      if ((status === 401 || status === 403) && err?.providerResponse) {
        err.providerAuthError = true;
        throw err;
      }
    }
  }
  throw lastError || new Error('Provider model catalog request failed');
}

export async function fetchModels(ownerId, providerId, { force = false } = {}) {
  const spec = effectiveSpecs(ownerId)[providerId];
  const key = getProviderKey(ownerId, providerId);
  if (!spec || spec.enabled === false) return { status: 'disabled', models: [] };
  if (!key) return { status: 'unauthorized', models: [] };
  const ck = `${ownerId}:${providerId}:${spec.kind}:${spec.baseURL}:${key.slice(-8)}`;
  const old = cache.get(ck);
  if (!force && old && Date.now() - old.at < CACHE_MS) return { status: 'cache', models: old.models, fetchedAt: old.at };

  try {
    const raw = await fetchModelList(spec, key);
    const models = parseModels(spec.kind, raw);
    cache.set(ck, { at: Date.now(), models });
    return { status: 'live', models, fetchedAt: Date.now() };
  } catch (err) {
    if (err.providerAuthError) return { status: 'unauthorized', models: [], error: err.message };
    if (old) return { status: 'stale', models: old.models, fetchedAt: old.at, error: err.message };
    return { status: 'error', models: [], error: err.message };
  }
}

function parseModels(kind, raw) {
  const arr = Array.isArray(raw?.data) ? raw.data
    : Array.isArray(raw?.models) ? raw.models
    : Array.isArray(raw) ? raw : [];
  return arr.map((item) => {
    const id = typeof item === 'string' ? item : item?.id || item?.name || '';
    if (!id) return null;
    const cleanId = id.replace(/^models\//, '');
    const isFree = /:free$/i.test(cleanId) || /free/i.test(cleanId);
    return {
      id: cleanId,
      name: item?.displayName || item?.name || cleanId,
      description: item?.description || undefined,
      free: isFree,
      contextLength: item?.context_length || item?.inputTokenLimit || undefined,
    };
  }).filter(Boolean);
}

export async function buildCatalog(ownerId, { force = false } = {}) {
  const specs = effectiveSpecs(ownerId);
  const hidden = new Set(listHiddenModels(ownerId));
  const manual = listManualModels(ownerId);
  const catalog = {};

  if (fixtureProviderEnabled()) {
    catalog[FIXTURE_PROVIDER_ID] = {
      provider: { id: FIXTURE_PROVIDER_ID, name: 'Deterministic Fixture', kind: 'fixture', custom: false },
      status: 'fixture',
      models: [{
        id: FIXTURE_MODEL_ID,
        name: 'Deterministic coding fixture (offline)',
        free: true,
        contextLength: 32_000,
        manual: false,
        hidden: false,
      }],
      fetchedAt: Date.now(),
    };
  }

  for (const [providerId, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue;
    const res = await fetchModels(ownerId, providerId, { force });
    const liveIds = new Set();
    const models = [];
    for (const m of res.models) {
      liveIds.add(m.id);
      const fullId = `${providerId}/${m.id}`;
      models.push({ ...m, manual: false, hidden: hidden.has(fullId) });
    }
    for (const m of manual.filter((x) => x.providerID === providerId)) {
      if (!liveIds.has(m.modelID)) {
        const fullId = `${providerId}/${m.modelID}`;
        models.push({ id: m.modelID, name: m.name || m.modelID, manual: true, hidden: hidden.has(fullId) });
      }
    }
    catalog[providerId] = {
      provider: { id: providerId, name: spec.name, kind: spec.kind, custom: Boolean(spec.custom) },
      status: res.status,
      error: res.error,
      models,
      fetchedAt: res.fetchedAt,
    };
  }
  return catalog;
}

export function resolveModel(ownerId, model) {
  if (typeof model !== 'string' || !model.trim()) throw Object.assign(new Error('Model is required'), { statusCode: 400 });
  const trimmed = model.trim();
  if (fixtureProviderEnabled() && (trimmed === `${FIXTURE_PROVIDER_ID}/${FIXTURE_MODEL_ID}` || trimmed === FIXTURE_MODEL_ID)) {
    return {
      providerId: FIXTURE_PROVIDER_ID,
      displayProviderId: FIXTURE_PROVIDER_ID,
      modelId: FIXTURE_MODEL_ID,
      spec: { id: FIXTURE_PROVIDER_ID, name: 'Deterministic Fixture', kind: 'fixture', baseURL: '', enabled: true, custom: false, trustedBaseURL: true },
      key: 'fixture-key',
      trustedBaseURL: true,
    };
  }

  const slash = trimmed.indexOf('/');
  if (slash === -1) throw Object.assign(new Error(`Model reference "${model}" must be in provider/model format`), { statusCode: 400 });
  const providerID = trimmed.slice(0, slash);
  const modelID = trimmed.slice(slash + 1);
  const specs = effectiveSpecs(ownerId);
  const spec = specs[providerID];
  if (!spec) throw Object.assign(new Error(`Неизвестный провайдер: ${providerID}`), { statusCode: 400 });
  const key = getProviderKey(ownerId, providerID);
  if (spec.enabled === false) throw Object.assign(new Error(`Провайдер ${spec.name} выключен`), { statusCode: 400 });
  if (!key) throw Object.assign(new Error(`API key для ${spec.name} не настроен`), { statusCode: 400 });
  return { providerId: providerID, displayProviderId: providerID, modelId: modelID, spec, key, trustedBaseURL: Boolean(spec.trustedBaseURL) };
}
