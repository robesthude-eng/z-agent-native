import { readJson, sendJson } from '../native/json.mjs';
import { handleProviderChannels } from '../native/provider-channels.mjs';
import { buildCatalog, providerList, providerSpecs } from '../native/providers.mjs';
import {
  deleteProviderKey, listProviderKeyIds, setProviderKey,
} from '../native/store.mjs';

function decodePathPart(part) {
  try { return decodeURIComponent(part); }
  catch { return part; }
}

export async function handleModelRoutes(req, res, p, url, ownerId) {
  if (await handleProviderChannels(req, res, ownerId, url)) return true;

  if (p === '/api/config/providers' && req.method === 'GET') {
    sendJson(res, 200, { providers: providerList(ownerId), default: {} });
    return true;
  }

  if (p === '/api/provider' && req.method === 'GET') {
    sendJson(res, 200, { connected: listProviderKeyIds(ownerId), all: providerList(ownerId), default: {} });
    return true;
  }

  if (p === '/api/auth/custom' && req.method === 'GET') {
    sendJson(res, 200, listProviderKeyIds(ownerId));
    return true;
  }

  if (p === '/api/auth/custom' && req.method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    if (!providerSpecs(ownerId)[body.providerId] || !String(body.key || '').trim()) {
      sendJson(res, 400, { error: 'providerId/key required' });
      return true;
    }
    setProviderKey(ownerId, body.providerId, String(body.key).trim());
    sendJson(res, 200, { status: 'success' });
    return true;
  }

  if (p === '/api/auth/custom' && req.method === 'DELETE') {
    const body = await readJson(req, 64 * 1024);
    deleteProviderKey(ownerId, body.providerId);
    sendJson(res, 200, { status: 'success' });
    return true;
  }

  const authProvider = /^\/api\/auth\/([^/]+)$/.exec(p);
  if (authProvider && !['custom', 'login', 'logout', 'register', 'me', 'change-password'].includes(authProvider[1])) {
    const providerId = decodePathPart(authProvider[1]);
    if (req.method === 'PUT') {
      if (!providerSpecs(ownerId)[providerId]) {
        sendJson(res, 404, { error: 'Unknown provider' });
        return true;
      }
      const body = await readJson(req, 128 * 1024);
      const key = body.key || body.apiKey;
      if (!key) {
        sendJson(res, 400, { error: 'key required' });
        return true;
      }
      setProviderKey(ownerId, providerId, String(key));
      sendJson(res, 200, true);
      return true;
    }
    if (req.method === 'DELETE') {
      deleteProviderKey(ownerId, providerId);
      sendJson(res, 204, null);
      return true;
    }
  }

  if (p === '/api/providers/models' && req.method === 'GET') {
    sendJson(res, 200, await buildCatalog(ownerId, { force: url.searchParams.get('refresh') === '1' }));
    return true;
  }

  return false;
}
