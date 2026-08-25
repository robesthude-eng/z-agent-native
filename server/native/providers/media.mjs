import {
  fetchJson, isTransientProviderError, providerAuth, providerError, providerFetch, routedProviderTarget, timeoutSignal,
} from './transport.mjs';
import { resolveModel } from './catalog.mjs';

export const MEDIA_UNSUPPORTED_KINDS = new Set(['anthropic', 'fixture']);
export const MEDIA_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MEDIA_REQUEST_TIMEOUT_MS = 180_000;

export function assertMediaCapableProvider(resolved, what = 'медиа-генерацию') {
  const kind = resolved?.spec?.kind || '';
  if (MEDIA_UNSUPPORTED_KINDS.has(kind)) {
    throw Object.assign(
      new Error(`Провайдер ${resolved?.spec?.name || kind} не поддерживает ${what}`),
      { statusCode: 400 },
    );
  }
  if (!resolved?.spec?.baseURL) {
    throw Object.assign(new Error('У провайдера не настроен baseURL'), { statusCode: 400 });
  }
  return resolved;
}

export function mediaEndpointUrl(resolved, apiPath) {
  const base = String(resolved.spec.baseURL || '').replace(/\/+$/, '');
  const tail = String(apiPath || '').replace(/^\/+/, '');
  return `${base}/${tail}`;
}

export function mediaHeaders(resolved, extra = {}) {
  return { 'content-type': 'application/json', ...providerAuth(resolved.spec, resolved.key), ...extra };
}

export async function callProviderJson(ownerId, model, { path, body, signal, retries = 1, timeoutMs = MEDIA_REQUEST_TIMEOUT_MS } = {}) {
  const resolved = assertMediaCapableProvider(resolveModel(ownerId, model));
  const url = mediaEndpointUrl(resolved, path);
  const target = await routedProviderTarget(url, resolved.trustedBaseURL);
  return await fetchJson(
    target,
    { method: 'POST', headers: mediaHeaders(resolved), body: JSON.stringify(body ?? {}) },
    signal,
    { retries, timeoutMs },
  );
}

export async function callProviderBinary(ownerId, model, {
  path,
  body,
  signal,
  timeoutMs = MEDIA_REQUEST_TIMEOUT_MS,
  maxBytes = MEDIA_MAX_RESPONSE_BYTES,
} = {}) {
  const resolved = assertMediaCapableProvider(resolveModel(ownerId, model));
  const url = mediaEndpointUrl(resolved, path);
  const target = await routedProviderTarget(url, resolved.trustedBaseURL);
  const attempts = [{ url: target.url, pinned: target.pinned }];
  if (target.fallback) attempts.push(target.fallback);

  let lastError = null;
  for (const attempt of attempts) {
    const t = timeoutSignal(timeoutMs, signal);
    try {
      const res = await providerFetch(attempt, {
        method: 'POST',
        headers: mediaHeaders(resolved),
        body: JSON.stringify(body ?? {}),
        signal: t.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        throw providerError(res, text, parsed);
      }
      const chunks = [];
      let total = 0;
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
          throw Object.assign(
            new Error(`Ответ провайдера больше лимита ${Math.round(maxBytes / (1024 * 1024))} МБ`),
            { statusCode: 502 },
          );
        }
        chunks.push(buf);
      }
      const mimeType = String(res.headers.get('content-type') || '').split(';')[0].trim();
      return { bytes: Buffer.concat(chunks, total), mimeType: mimeType || 'application/octet-stream' };
    } catch (err) {
      lastError = err;
      if (!isTransientProviderError(err, signal)) throw err;
    } finally {
      t.cleanup();
    }
  }
  throw lastError || new Error('Медиа-запрос к провайдеру не удался');
}
