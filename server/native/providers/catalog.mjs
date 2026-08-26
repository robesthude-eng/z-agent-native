import { getProviderKey, listHiddenModels, listManualModels } from '../store.mjs';
import { listProviderConfigs } from '../provider-configs.mjs';
import {
  assertSafeProviderUrl, fetchJson, providerAuth, publicProviderErrorMessage, wrapProviderUrl,
} from './transport.mjs';
import { probeModel } from './caller.mjs';

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
    const body = await fetchModelList(spec, key);
    let models = [];
    if (spec.kind === 'google') {
      models = (body?.models || []).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || String(m.name || '').replace(/^models\//, '') })).filter((m) => m.id);
    } else {
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      models = rows.map((m) => ({ id: String(m.id || m.name || ''), name: m.display_name || m.name || m.id })).filter((m) => m.id);
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    cache.set(ck, { at: Date.now(), models });
    return { status: 'live', models, fetchedAt: Date.now() };
  } catch (err) {
    const publicError = publicProviderErrorMessage(err);
    if (force) {
      cache.delete(ck);
      return { status: err?.providerAuthError ? 'unauthorized' : 'unavailable', models: [], error: publicError };
    }
    if (old) return { status: 'cache', models: old.models, error: publicError, stale: true, fetchedAt: old.at };
    return { status: err?.providerAuthError ? 'unauthorized' : 'unavailable', models: [], error: publicError };
  }
}

function expandFinitePattern(pattern, limit = 64) {
  const input = String(pattern || '').trim();
  if (!input) return [];
  if (/[*?[]/.test(input)) return [];
  const values = [input];
  for (;;) {
    const idx = values.findIndex((v) => /\{[^{}]+\}/.test(v));
    if (idx < 0) break;
    const current = values[idx];
    const m = /\{([^{}]+)\}/.exec(current);
    const choices = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    const next = choices.map((c) => current.slice(0, m.index) + c + current.slice(m.index + m[0].length));
    values.splice(idx, 1, ...next);
    if (values.length > limit) throw new Error(`Pattern expands to more than ${limit} models`);
  }
  return [...new Set(values)].slice(0, limit);
}

async function discoveredFromPattern(ownerId, providerId, pattern) {
  const ck = `${ownerId}:${providerId}:${pattern.model_id}:${pattern.base_url || ''}`;
  const old = discoveryCache.get(ck);
  if (old && Date.now() - old.at < 10 * 60 * 1000) return old.models;
  const candidates = expandFinitePattern(pattern.model_id);
  const found = [];
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = candidates.slice(i, i + 4);
    const results = await Promise.all(batch.map(async (modelId) => ({ modelId, result: await probeModel(ownerId, providerId, { modelId, baseUrl: pattern.base_url }) })));
    for (const x of results) if (x.result.available) found.push(x.modelId);
  }
  discoveryCache.set(ck, { at: Date.now(), models: found });
  return found;
}

function manualProviderId(providerId, model) {
  return model.base_url ? `custom:${providerId}:${Buffer.from(model.base_url).toString('base64url').slice(0, 20)}` : providerId;
}

export async function buildCatalog(ownerId, { force = false } = {}) {
  const models = [];
  const providers = {};
  const hiddenByProvider = {};
  const specs = effectiveSpecs(ownerId);
  for (const [providerId, spec] of Object.entries(specs)) {
    const found = await fetchModels(ownerId, providerId, { force });
    providers[providerId] = {
      status: found.status,
      count: found.models.length,
      ...(found.error ? { error: found.error } : {}),
      ...(found.stale ? { stale: true } : {}),
      ...(found.fetchedAt ? { fetchedAt: found.fetchedAt } : {}),
    };
    const hiddenList = listHiddenModels(ownerId, providerId);
    if (hiddenList.length) hiddenByProvider[providerId] = hiddenList;
    const hidden = new Set(hiddenList);
    for (const model of found.models) {
      if (hidden.has(model.id)) continue;
      models.push({ providerID: providerId, sourceProviderID: providerId, providerName: spec.name, modelID: model.id, modelName: model.name, free: false, source: 'catalog', status: found.status });
    }
    for (const manual of listManualModels(ownerId, providerId)) {
      if (!manual.enabled) continue;
      if (manual.pattern) {
        let discovered = [];
        try { discovered = await discoveredFromPattern(ownerId, providerId, manual); } catch { discovered = []; }
        for (const modelId of discovered) {
          if (hidden.has(modelId)) continue;
          models.push({
            providerID: manualProviderId(providerId, manual), sourceProviderID: providerId,
            providerName: manual.base_url ? `${spec.name} · Custom` : spec.name,
            modelID: modelId, modelName: modelId, free: manual.is_free, source: 'discovered',
            endpoint: manual.base_url, status: 'live',
          });
        }
        continue;
      }
      if (hidden.has(manual.model_id)) continue;
      models.push({
        providerID: manualProviderId(providerId, manual),
        sourceProviderID: providerId,
        providerName: manual.base_url ? `${spec.name} · Custom` : spec.name,
        modelID: manual.model_id,
        modelName: manual.name || manual.model_id,
        free: manual.is_free,
        source: manual.base_url ? 'custom' : 'manual',
        endpoint: manual.base_url,
        status: 'live',
      });
    }
  }
  if (fixtureProviderEnabled()) {
    providers[FIXTURE_PROVIDER_ID] = { status: 'live', count: 1 };
    models.unshift({
      providerID: FIXTURE_PROVIDER_ID,
      sourceProviderID: FIXTURE_PROVIDER_ID,
      providerName: 'Deterministic Fixture',
      modelID: FIXTURE_MODEL_ID,
      modelName: 'Coding E2E Fixture',
      free: true,
      source: 'fixture',
      status: 'live',
    });
  }
  const unique = new Map();
  for (const m of models) unique.set(`${m.providerID}\0${m.modelID}`, m);
  const defaults = {};
  const configured = String(process.env.Z_AGENT_DEFAULT_MODEL || '').trim();
  if (configured.includes('/')) {
    const slash = configured.indexOf('/');
    const providerID = configured.slice(0, slash);
    const modelID = configured.slice(slash + 1);
    if (providerID && modelID) defaults[providerID] = modelID;
  }
  return { models: [...unique.values()], providers, hidden: hiddenByProvider, default: defaults, generatedAt: Date.now() };
}

export function resolveModel(ownerId, model) {
  let providerID = '';
  let modelID = '';
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    if (slash !== -1) {
      providerID = model.slice(0, slash);
      modelID = model.slice(slash + 1);
    }
  } else if (model && typeof model === 'object') {
    providerID = model.providerID || model.providerId || '';
    modelID = model.modelID || model.modelId || '';
  }
  if (!providerID || !modelID) throw Object.assign(new Error('Модель не выбрана'), { statusCode: 400 });

  if (providerID === FIXTURE_PROVIDER_ID) {
    if (!fixtureProviderEnabled() || modelID !== FIXTURE_MODEL_ID) {
      throw Object.assign(new Error('Fixture model is unavailable'), { statusCode: 404 });
    }
    return {
      providerId: providerID,
      displayProviderId: providerID,
      modelId: modelID,
      spec: { id: providerID, name: 'Deterministic Fixture', kind: 'fixture', baseURL: '', enabled: true },
      key: '',
      trustedBaseURL: true,
    };
  }

  const specs = effectiveSpecs(ownerId);
  if (providerID.startsWith('custom:')) {
    for (const [sourceId, spec] of Object.entries(specs)) {
      const manual = listManualModels(ownerId, sourceId).find((m) => {
        if (!m.enabled || manualProviderId(sourceId, m) !== providerID) return false;
        if (!m.pattern) return m.model_id === modelID;
        try { return expandFinitePattern(m.model_id).includes(modelID); } catch { return false; }
      });
      if (manual) {
        return {
          providerId: sourceId,
          displayProviderId: providerID,
          modelId: modelID,
          spec: { ...spec, baseURL: manual.base_url },
          key: getProviderKey(ownerId, sourceId),
          trustedBaseURL: false,
        };
      }
    }
  }

  const spec = specs[providerID];
  const key = getProviderKey(ownerId, providerID);
  if (!spec) throw Object.assign(new Error(`Неизвестный провайдер: ${providerID}`), { statusCode: 400 });
  if (spec.enabled === false) throw Object.assign(new Error(`Провайдер ${spec.name} выключен`), { statusCode: 400 });
  if (!key) throw Object.assign(new Error(`API key для ${spec.name} не настроен`), { statusCode: 400 });
  return {
    providerId: providerID,
    displayProviderId: providerID,
    modelId: modelID,
    spec,
    key,
    trustedBaseURL: Boolean(spec.trustedBaseURL),
  };
}
