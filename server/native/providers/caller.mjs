import { getProviderKey } from '../store.mjs';
import { effectiveSpecs, fixtureResponse, resolveModel } from './catalog.mjs';
import { callAnthropic, callGoogle, callOpenAI } from './streaming.mjs';
import { publicProviderErrorMessage } from './transport.mjs';

export async function callModel(ownerId, model, request) {
  const resolved = resolveModel(ownerId, model);
  if (resolved.spec.kind === 'fixture') return fixtureResponse(request);
  if (resolved.spec.kind === 'anthropic') return callAnthropic(resolved, request);
  if (resolved.spec.kind === 'google') return callGoogle(resolved, request);
  return callOpenAI(resolved, request);
}

export async function probeModel(ownerId, providerId, { modelId, baseUrl = null }) {
  const start = Date.now();
  const spec = effectiveSpecs(ownerId)[providerId];
  const key = getProviderKey(ownerId, providerId);
  if (!spec || spec.enabled === false || !key) {
    return { available: false, latencyMs: Date.now() - start, checkedAt: Date.now(), error: 'API key не настроен или провайдер выключен' };
  }
  try {
    const resolved = {
      providerId,
      displayProviderId: providerId,
      modelId,
      spec: { ...spec, ...(baseUrl ? { baseURL: baseUrl } : {}) },
      key,
      trustedBaseURL: baseUrl ? false : Boolean(spec.trustedBaseURL),
    };
    const pingTools = [];
    const result = resolved.spec.kind === 'anthropic'
      ? await callAnthropic(resolved, { system: 'Reply with OK.', frames: [{ role: 'user', content: 'OK' }], tools: pingTools })
      : resolved.spec.kind === 'google'
        ? await callGoogle(resolved, { system: 'Reply with OK.', frames: [{ role: 'user', content: 'OK' }], tools: pingTools })
        : await callOpenAI(resolved, { system: 'Reply with OK.', frames: [{ role: 'user', content: 'OK' }], tools: pingTools });
    return { available: Boolean(result.text || result.finish), latencyMs: Date.now() - start, checkedAt: Date.now() };
  } catch (err) {
    return { available: false, latencyMs: Date.now() - start, checkedAt: Date.now(), error: publicProviderErrorMessage(err) };
  }
}
