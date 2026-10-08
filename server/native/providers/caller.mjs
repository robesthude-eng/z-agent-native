import { getProviderKey } from '../store.mjs';
import { effectiveSpecs, fixtureResponse, resolveModel } from './catalog.mjs';
import { callAnthropic, callGoogle, callOpenAI } from './streaming.mjs';
import { publicProviderErrorMessage } from './transport.mjs';

/**
 * `systemTail` — часть системного промпта, которая меняется от шага к шагу. Anthropic получает её
 * отдельным блоком после кэшируемой части; остальные провайдеры — склеенной в один system.
 */
export function foldSystemTail(resolved, request) {
  if (!request?.systemTail || resolved.spec.kind === 'anthropic') return request;
  const { systemTail, ...rest } = request;
  return { ...rest, system: [rest.system, systemTail].filter(Boolean).join('\n\n') };
}

export async function callModel(ownerId, model, request) {
  const resolved = resolveModel(ownerId, model);
  const req = foldSystemTail(resolved, request);
  if (resolved.spec.kind === 'fixture') return fixtureResponse(req);
  if (resolved.spec.kind === 'anthropic') return callAnthropic(resolved, req);
  if (resolved.spec.kind === 'google') return callGoogle(resolved, req);
  return callOpenAI(resolved, req);
}

// Красный квадрат 32×32 для проверки, видит ли модель изображения.
const PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAK0lEQVR4nO3NQQEAAATAQGTQP5kwSvC7BdjldMdn9XoHAAAAAAAAAAAAhy3gIwFE6inHLwAAAABJRU5ErkJggg==';
const PROBE_TOOL = {
  name: 'report_status',
  description: 'Report the probe status.',
  inputSchema: {
    type: 'object',
    properties: { status: { type: 'string', enum: ['ok'] } },
    required: ['status'],
    additionalProperties: false,
  },
};

function callByKind(resolved, rawRequest) {
  const request = foldSystemTail(resolved, rawRequest);
  if (resolved.spec.kind === 'anthropic') return callAnthropic(resolved, request);
  if (resolved.spec.kind === 'google') return callGoogle(resolved, request);
  return callOpenAI(resolved, request);
}

/**
 * Проверка возможностей, нужных агенту. Ответ «OK» без инструментов ничего
 * не говорит о function calling и картинках, поэтому каждая проверяется
 * отдельным запросом. true / false — подтверждено / нет, null — проверка
 * не дала ответа (ошибка сети, лимит).
 */
async function probeCapabilities(resolved) {
  const out = { tools: null, vision: null };
  try {
    const r = await callByKind(resolved, {
      system: 'You are a connectivity probe. Use the provided tool.',
      frames: [{ role: 'user', content: 'Call the report_status tool with status "ok". Do not answer with text.' }],
      tools: [PROBE_TOOL],
    });
    out.tools = (r.toolCalls || []).some((c) => c.name === 'report_status');
  } catch (err) {
    const status = Number(err?.statusCode) || 0;
    out.tools = status >= 400 && status < 500 && status !== 429 ? false : null;
  }
  try {
    const r = await callByKind(resolved, {
      system: 'Answer with one word.',
      frames: [
        { role: 'user', content: 'What is the main color of this image? One word.', media: [{ dataUrl: PROBE_IMAGE, name: 'probe.png' }] },
      ],
      tools: [],
    });
    out.vision = /red|красн|rojo|rouge|rot/i.test(String(r.text || ''));
  } catch (err) {
    const status = Number(err?.statusCode) || 0;
    out.vision = status >= 400 && status < 500 && status !== 429 ? false : null;
  }
  return out;
}

export async function probeModel(ownerId, providerId, { modelId, baseUrl = null, capabilities = false }) {
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
    const result =
      resolved.spec.kind === 'anthropic'
        ? await callAnthropic(resolved, { system: 'Reply with OK.', frames: [{ role: 'user', content: 'OK' }], tools: pingTools })
        : resolved.spec.kind === 'google'
          ? await callGoogle(resolved, { system: 'Reply with OK.', frames: [{ role: 'user', content: 'OK' }], tools: pingTools })
          : await callOpenAI(resolved, { system: 'Reply with OK.', frames: [{ role: 'user', content: 'OK' }], tools: pingTools });
    const available = Boolean(result.text || result.finish);
    const latencyMs = Date.now() - start;
    if (!available || !capabilities) return { available, latencyMs, checkedAt: Date.now() };
    return { available, latencyMs, checkedAt: Date.now(), capabilities: await probeCapabilities(resolved) };
  } catch (err) {
    return { available: false, latencyMs: Date.now() - start, checkedAt: Date.now(), error: publicProviderErrorMessage(err) };
  }
}
