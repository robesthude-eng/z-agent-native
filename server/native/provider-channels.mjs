import { readJson, sendJson } from './json.mjs';
import {
  deleteProviderConfig,
  getProviderConfig,
  listProviderConfigs,
  newCustomProviderId,
  upsertProviderConfig,
} from './provider-configs.mjs';
import {
  fetchModels,
  probeModel,
} from './providers.mjs';
import {
  deleteManualModel,
  deleteProviderKey,
  getProviderKey,
  listHiddenModels,
  listManualModels,
  listProviderKeyIds,
  setHiddenModel,
  setProviderKey,
  upsertManualModel,
} from './store.mjs';

function reply(res, status, body) {
  sendJson(res, status, body);
  return true;
}

function decodePathPart(value) {
  try { return decodeURIComponent(value); }
  catch { throw Object.assign(new Error('Bad request'), { statusCode: 400 }); }
}

/**
 * Provider management is intentionally user-defined only.
 * Runtime protocol adapters may know how to speak OpenAI/Anthropic/Gemini,
 * but they must never materialize branded provider templates in the UI.
 */
export function listProviderChannels(ownerId) {
  const connected = new Set(listProviderKeyIds(ownerId));
  const rows = listProviderConfigs(ownerId).map((provider) => ({
    ...provider,
    custom: true,
    connected: connected.has(provider.id),
    overridden: false,
  }));
  if (process.env.Z_AGENT_ENABLE_FIXTURE_PROVIDER === '1') {
    rows.unshift({ id: 'fixture', name: 'Deterministic Fixture', protocol: 'openai', baseURL: '', enabled: true, custom: false, connected: true, overridden: false });
  }
  return rows;
}

function providerExists(ownerId, providerId) {
  return Boolean(getProviderConfig(ownerId, providerId));
}

export async function handleProviderChannels(req, res, ownerId, url) {
  const p = url.pathname;
  if (p === '/api/provider-channels' && req.method === 'GET') {
    return reply(res, 200, { providers: listProviderChannels(ownerId) });
  }

  if (p === '/api/provider-channels' && req.method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    const id = String(body.id || '').trim() || newCustomProviderId();
    const config = upsertProviderConfig(ownerId, {
      id,
      name: body.name,
      protocol: body.protocol,
      baseURL: body.baseURL,
      enabled: body.enabled !== false,
    }, { custom: true });
    if (typeof body.key === 'string' && body.key.trim()) setProviderKey(ownerId, id, body.key.trim());
    const hasKey = Boolean(getProviderKey(ownerId, id));
    const catalog = hasKey && config.enabled
      ? await fetchModels(ownerId, id, { force: true })
      // Выключенный канал остаётся выключенным, даже если ключа ещё нет:
      // иначе UI просит добавить ключ вместо того, чтобы включить канал.
      : { status: config.enabled ? 'unauthorized' : 'disabled', models: [] };
    return reply(res, 200, {
      provider: listProviderChannels(ownerId).find((item) => item.id === id),
      catalog: { status: catalog.status, count: catalog.models.length, error: catalog.error || null },
    });
  }

  const match = /^\/api\/provider-channels\/([^/]+)(?:\/(key|refresh|manual-models|hidden-models)(?:\/(probe))?)?$/.exec(p);
  if (!match) return false;
  const providerId = decodePathPart(match[1]);
  const action = match[2] || '';
  const subAction = match[3] || '';

  if (!providerExists(ownerId, providerId)) return reply(res, 404, { error: 'Unknown provider' });

  if (!action && req.method === 'DELETE') {
    deleteProviderConfig(ownerId, providerId, { deleteData: true });
    return reply(res, 200, { status: 'success' });
  }

  if (action === 'key' && req.method === 'DELETE') {
    deleteProviderKey(ownerId, providerId);
    return reply(res, 200, { status: 'success' });
  }

  if (action === 'refresh' && req.method === 'POST') {
    const catalog = await fetchModels(ownerId, providerId, { force: true });
    return reply(res, 200, { status: catalog.status, models: catalog.models, error: catalog.error || null });
  }

  if (action === 'manual-models') {
    // Проверка Model ID без сохранения: пользователь видит вердикт провайдера
    // до того, как модель попадёт в выпадающий список.
    if (subAction === 'probe') {
      if (req.method !== 'POST') return false;
      const body = await readJson(req, 64 * 1024);
      const modelId = String(body.modelId || '').trim();
      if (!modelId || modelId.length > 200) return reply(res, 400, { error: 'Некорректный Model ID' });
      return reply(res, 200, await probeModel(ownerId, providerId, { modelId }));
    }
    if (req.method === 'GET') return reply(res, 200, { models: listManualModels(ownerId, providerId) });
    if (req.method === 'POST') {
      const body = await readJson(req, 128 * 1024);
      const modelId = String(body.modelId || '').trim();
      if (!modelId || modelId.length > 200) return reply(res, 400, { error: 'Некорректный Model ID' });
      const existing = listManualModels(ownerId, providerId).find((row) => row.model_id === modelId) || null;
      // probe:false — это переключение флагов уже проверенной модели, поэтому
      // провайдера не дёргаем, а неуказанные поля берём из сохранённой строки.
      const probe = body.probe === false ? null : await probeModel(ownerId, providerId, { modelId });
      if (probe && !probe.available) return reply(res, 400, { error: probe.error || 'Модель недоступна' });
      const pick = (value, previous) => (value === undefined || value === null ? previous : value);
      upsertManualModel(ownerId, providerId, {
        modelId,
        name: pick(body.name, existing?.name ?? null),
        baseUrl: null,
        isFree: Boolean(pick(body.isFree, existing?.is_free ?? false)),
        pattern: false,
        enabled: pick(body.enabled, existing?.enabled ?? true) !== false,
      });
      return reply(res, 200, { status: 'success', available: probe?.available ?? null });
    }
    if (req.method === 'DELETE') {
      const body = await readJson(req, 64 * 1024);
      const modelId = String(body.modelId || '').trim();
      if (!modelId) return reply(res, 400, { error: 'Некорректный Model ID' });
      deleteManualModel(ownerId, providerId, modelId);
      return reply(res, 200, { status: 'success' });
    }
  }

  // Скрытие моделей живёт рядом с каналом, поэтому наследует его проверку
  // существования провайдера вместо legacy-маршрута без валидации.
  if (action === 'hidden-models') {
    if (req.method === 'GET') return reply(res, 200, { hidden: listHiddenModels(ownerId, providerId) });
    if (req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const modelId = String(body.modelId || '').trim();
      if (!modelId || modelId.length > 200) return reply(res, 400, { error: 'Некорректный Model ID' });
      setHiddenModel(ownerId, providerId, modelId, Boolean(body.hidden));
      return reply(res, 200, { status: 'success' });
    }
  }

  return false;
}
