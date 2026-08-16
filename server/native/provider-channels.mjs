import { readJson, sendJson } from './json.mjs';
import {
  deleteProviderConfig,
  getProviderConfig,
  newCustomProviderId,
  upsertProviderConfig,
} from './provider-configs.mjs';
import {
  fetchModels,
  isBuiltInProvider,
  probeModel,
  providerList,
  providerSpecs,
} from './providers.mjs';
import {
  deleteManualModel,
  deleteProviderKey,
  getProviderKey,
  listManualModels,
  listProviderKeyIds,
  setProviderKey,
  upsertManualModel,
} from './store.mjs';

function reply(res, status, body) {
  sendJson(res, status, body);
  return true;
}

function channelSnapshot(ownerId) {
  const connected = new Set(listProviderKeyIds(ownerId));
  return providerList(ownerId).map((provider) => ({
    ...provider,
    connected: connected.has(provider.id),
    overridden: Boolean(getProviderConfig(ownerId, provider.id)),
  }));
}

function providerExists(ownerId, providerId) {
  return Boolean(providerSpecs(ownerId)[providerId]);
}

export async function handleProviderChannels(req, res, ownerId, url) {
  const p = url.pathname;
  if (p === '/api/provider-channels' && req.method === 'GET') {
    return reply(res, 200, { providers: channelSnapshot(ownerId) });
  }

  if (p === '/api/provider-channels' && req.method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    const id = String(body.id || '').trim() || newCustomProviderId();
    const builtin = isBuiltInProvider(id);
    const config = upsertProviderConfig(ownerId, {
      id,
      name: body.name,
      protocol: body.protocol,
      baseURL: body.baseURL,
      enabled: body.enabled !== false,
    }, { custom: !builtin });
    if (typeof body.key === 'string' && body.key.trim()) setProviderKey(ownerId, id, body.key.trim());
    const hasKey = Boolean(getProviderKey(ownerId, id));
    const catalog = hasKey && config.enabled
      ? await fetchModels(ownerId, id, { force: true })
      : { status: hasKey ? 'disabled' : 'unauthorized', models: [] };
    return reply(res, 200, {
      provider: channelSnapshot(ownerId).find((item) => item.id === id),
      catalog: { status: catalog.status, count: catalog.models.length, error: catalog.error || null },
    });
  }

  const match = /^\/api\/provider-channels\/([^/]+)(?:\/(key|refresh|config|manual-models))?$/.exec(p);
  if (!match) return false;
  const providerId = decodeURIComponent(match[1]);
  const action = match[2] || '';

  if (!providerExists(ownerId, providerId)) return reply(res, 404, { error: 'Unknown provider' });

  if (!action && req.method === 'DELETE') {
    if (isBuiltInProvider(providerId)) return reply(res, 400, { error: 'Встроенный провайдер нельзя удалить; сбросьте его настройки.' });
    deleteProviderConfig(ownerId, providerId, { deleteData: true });
    return reply(res, 200, { status: 'success' });
  }

  if (action === 'config' && req.method === 'DELETE') {
    if (!isBuiltInProvider(providerId)) return reply(res, 400, { error: 'Для custom-провайдера используйте удаление провайдера.' });
    deleteProviderConfig(ownerId, providerId, { deleteData: false });
    return reply(res, 200, { status: 'success', provider: channelSnapshot(ownerId).find((item) => item.id === providerId) });
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
    if (req.method === 'GET') return reply(res, 200, { models: listManualModels(ownerId, providerId) });
    if (req.method === 'POST') {
      const body = await readJson(req, 128 * 1024);
      const modelId = String(body.modelId || '').trim();
      if (!modelId || modelId.length > 200) return reply(res, 400, { error: 'Некорректный Model ID' });
      const probe = body.probe === false ? null : await probeModel(ownerId, providerId, { modelId });
      if (probe && !probe.available) return reply(res, 400, { error: probe.error || 'Модель недоступна' });
      upsertManualModel(ownerId, providerId, {
        modelId,
        name: body.name || null,
        baseUrl: null,
        isFree: Boolean(body.isFree),
        pattern: false,
        enabled: body.enabled !== false,
      });
      return reply(res, 200, { status: 'success', available: probe?.available ?? null });
    }
    if (req.method === 'DELETE') {
      const body = await readJson(req, 64 * 1024);
      deleteManualModel(ownerId, providerId, body.modelId);
      return reply(res, 200, { status: 'success' });
    }
  }

  return false;
}
