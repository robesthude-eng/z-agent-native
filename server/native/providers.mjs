import { assertSafeExternalUrl } from './security.mjs';
import { getProviderKey, listManualModels, listHiddenModels } from './store.mjs';
import { listProviderConfigs } from './provider-configs.mjs';


// --- Auto relay wrapper ---
// If Z_AGENT_RELAY_URL env var is set, ALL external provider URLs are
// transparently routed through the Worker relay (which forwards them via
// Railway for geo-block bypass). Users enter real provider Base URLs from
// documentation; the runtime handles the relay wrapping automatically.
const RELAY_BASE = (process.env.Z_AGENT_RELAY_URL || '').replace(/\/\/+$/, '');
const RELAY_ENABLED = Boolean(RELAY_BASE);

function wrapProviderUrl(url) {
  if (!RELAY_ENABLED) return url;
  try {
    const parsed = new URL(url);
    if (parsed.host === new URL(RELAY_BASE).host) return url;
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return url;
    if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) return url;
    const stripped = url.replace(/^https?:\/\//, '');
    return RELAY_BASE + '/' + stripped;
  } catch {
    return url;
  }
}
// --- /Auto relay wrapper ---

const builtInSpecs = {}; // No builtin provider templates — only user-defined (custom) channels.

function effectiveSpecs(ownerId) {
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
const reqTimeout = 30_000;

export function isBuiltInProvider(providerId) { return Boolean(builtInSpecs[providerId]); }
export function providerSpecs(ownerId = null) { return effectiveSpecs(ownerId); }
export function providerList(ownerId = null) {
  return Object.entries(effectiveSpecs(ownerId)).map(([id, spec]) => ({
    id,
    name: spec.name,
    protocol: spec.kind,
    baseURL: spec.baseURL,
    enabled: spec.enabled !== false,
    custom: Boolean(spec.custom),
    models: {},
  }));
}

function timeoutSignal(ms = reqTimeout, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  return { signal: controller.signal, cleanup() { clearTimeout(timer); outerSignal?.removeEventListener('abort', onAbort); } };
}

function providerError(res, text, body = null) {
  const message = body?.error?.message || body?.message || String(text || '').slice(0, 500) || `${res.status} ${res.statusText}`;
  const err = new Error(message);
  err.statusCode = res.status;
  err.body = body;
  return err;
}

function transientStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchJson(url, init, outerSignal, { retries = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t = timeoutSignal(reqTimeout, outerSignal);
    try {
      const res = await fetch(url, { ...init, signal: t.signal });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
      if (!res.ok) throw providerError(res, text, body);
      if (body === null && text) throw new Error('Provider returned non-JSON response');
      return body;
    } catch (err) {
      lastError = err;
      const aborted = outerSignal?.aborted || err?.name === 'AbortError';
      const retryable = !aborted && (transientStatus(Number(err?.statusCode)) || !err?.statusCode);
      if (!retryable || attempt >= retries) throw err;
    } finally {
      t.cleanup();
    }
    await sleep(Math.min(2000, 250 * (2 ** attempt) + Math.floor(Math.random() * 150)), outerSignal);
  }
  throw lastError || new Error('Provider request failed');
}

async function fetchSse(url, init, outerSignal, onEvent) {
  const t = timeoutSignal(Math.max(reqTimeout, 120_000), outerSignal);
  try {
    const res = await fetch(url, { ...init, signal: t.signal });
    if (!res.ok) {
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      throw providerError(res, text, body);
    }
    if (!res.body) throw new Error('Provider returned an empty streaming response');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventData = [];
    const flush = () => {
      if (eventData.length === 0) return;
      const raw = eventData.join('\n');
      eventData = [];
      if (raw === '[DONE]') return;
      try { onEvent(JSON.parse(raw)); } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) { flush(); continue; }
        if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
      }
      if (done) break;
    }
    if (buffer.trim().startsWith('data:')) eventData.push(buffer.trim().slice(5).trimStart());
    flush();
  } finally {
    t.cleanup();
  }
}

function providerAuth(spec, key) {
  if (spec.kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (spec.kind === 'google') return {};
  return { authorization: `Bearer ${key}` };
}

function modelListUrls(spec, key) {
  const base = spec.baseURL.replace(/\/$/, '');
  const direct = spec.kind === 'google'
    ? `${base}/models?key=${encodeURIComponent(key)}`
    : `${base}/models`;
  const relayed = wrapProviderUrl(direct);
  return [...new Set([relayed, direct])];
}

async function fetchModelList(spec, key) {
  const headers = {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'Z-Agent/1.0',
    ...providerAuth(spec, key),
  };
  let lastError = null;
  for (const url of modelListUrls(spec, key)) {
    try {
      if (!spec.trustedBaseURL) await assertSafeExternalUrl(url);
      return await fetchJson(url, { headers });
    } catch (err) {
      lastError = err;
      const status = Number(err?.statusCode) || 0;
      // Authentication errors are route-independent. Everything else gets one
      // alternate-route attempt, because relays/proxies can terminate or alter
      // otherwise valid GET /models responses while chat POSTs still work.
      if (status === 401 || status === 403) throw err;
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
  if (!force && old && Date.now() - old.at < CACHE_MS) return { status: 'cache', models: old.models };
  try {
    const body = await fetchModelList(spec, key);
    let models = [];
    if (spec.kind === 'google') {
      models = (body?.models || []).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || String(m.name || '').replace(/^models\//, '') })).filter((m) => m.id);
    } else {
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      models = rows.map((m) => ({ id: String(m.id || m.name || ''), name: m.display_name || m.name || m.id })).filter((m) => m.id);
    }
    models.sort((a,b) => a.name.localeCompare(b.name));
    cache.set(ck, { at: Date.now(), models });
    return { status: 'live', models };
  } catch (err) {
    if (old) return { status: 'cache', models: old.models, error: err.message };
    return { status: err.statusCode === 401 || err.statusCode === 403 ? 'unauthorized' : 'unavailable', models: [], error: err.message };
  }
}

function expandFinitePattern(pattern, limit = 64) {
  const input = String(pattern || '').trim();
  if (!input) return [];
  if (/[*?\[]/.test(input)) return [];
  let values = [input];
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
  const specs = effectiveSpecs(ownerId);
  for (const [providerId, spec] of Object.entries(specs)) {
    const found = await fetchModels(ownerId, providerId, { force });
    providers[providerId] = { status: found.status, count: found.models.length };
    const hidden = new Set(listHiddenModels(ownerId, providerId));
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
  return { models: [...unique.values()], providers, default: defaults, generatedAt: Date.now() };
}

export function resolveModel(ownerId, model) {
  const providerID = model?.providerID || '';
  const modelID = model?.modelID || '';
  if (!providerID || !modelID) throw Object.assign(new Error('Модель не выбрана'), { statusCode: 400 });
  const specs = effectiveSpecs(ownerId);
  if (providerID.startsWith('custom:')) {
    for (const [sourceId, spec] of Object.entries(specs)) {
      const manual = listManualModels(ownerId, sourceId).find((m) => {
        if (!m.enabled || manualProviderId(sourceId, m) !== providerID) return false;
        if (!m.pattern) return m.model_id === modelID;
        try { return expandFinitePattern(m.model_id).includes(modelID); } catch { return false; }
      });
      if (manual) return { providerId: sourceId, displayProviderId: providerID, modelId: modelID, spec: { ...spec, baseURL: manual.base_url }, key: getProviderKey(ownerId, sourceId), trustedBaseURL: false };
    }
  }
  const spec = specs[providerID];
  const key = getProviderKey(ownerId, providerID);
  if (!spec) throw Object.assign(new Error(`Неизвестный провайдер: ${providerID}`), { statusCode: 400 });
  if (spec.enabled === false) throw Object.assign(new Error(`Провайдер ${spec.name} выключен`), { statusCode: 400 });
  if (!key) throw Object.assign(new Error(`API key для ${spec.name} не настроен`), { statusCode: 400 });
  return { providerId: providerID, displayProviderId: providerID, modelId: modelID, spec, key, trustedBaseURL: Boolean(spec.trustedBaseURL) };
}

function safeJsonArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  const mediaType = match[1] || 'application/octet-stream';
  try {
    const data = match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3]), 'utf8').toString('base64');
    return { mediaType, data, dataUrl: String(dataUrl) };
  } catch { return null; }
}

function mediaNote(media) {
  return media?.name ? `[Attached file: ${media.name}]` : '[Attached file]';
}

function openAiMessages(frames) {
  const out = [];
  for (const f of frames) {
    if (f.role === 'user') {
      const media = Array.isArray(f.media) ? f.media : [];
      if (media.length === 0) {
        out.push({ role: 'user', content: f.content || '' });
      } else {
        const content = [];
        if (f.content) content.push({ type: 'text', text: f.content });
        for (const item of media) {
          const parsed = parseDataUrl(item.dataUrl);
          if (parsed?.mediaType.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: parsed.dataUrl } });
          else content.push({ type: 'text', text: mediaNote(item) + ' The file is available in the workspace; inspect it with tools if needed.' });
        }
        out.push({ role: 'user', content });
      }
    } else if (f.role === 'assistant') {
      const msg = { role: 'assistant', content: f.content || null };
      if (f.toolCalls?.length) msg.tool_calls = f.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }));
      out.push(msg);
    } else if (f.role === 'tool') out.push({ role: 'tool', tool_call_id: f.callId, content: f.content });
  }
  return out;
}

async function callOpenAI(resolved, { system, frames, tools, signal, onTextDelta }) {
  const url = wrapProviderUrl(`${resolved.spec.baseURL.replace(/\/$/, '')}/chat/completions`);
  if (!resolved.trustedBaseURL) await assertSafeExternalUrl(url);
  const request = {
    model: resolved.modelId,
    messages: [{ role: 'system', content: system }, ...openAiMessages(frames)],
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    tool_choice: 'auto',
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${resolved.key}` };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(request) }, signal);
    const choice = body?.choices?.[0];
    const msg = choice?.message || {};
    const toolCalls = (msg.tool_calls || []).map((c) => ({ id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function?.name || '', arguments: safeJsonArgs(c.function?.arguments) })).filter((c) => c.name);
    return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls, usage: body?.usage || null, finish: choice?.finish_reason || null, streamed: false };
  }

  let text = '';
  let usage = null;
  let finish = null;
  const calls = new Map();
  await fetchSse(url, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) }, signal, (event) => {
    if (event?.usage) usage = event.usage;
    const choice = event?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onTextDelta(delta.content);
    }
    for (const piece of delta.tool_calls || []) {
      const index = Number.isInteger(piece.index) ? piece.index : calls.size;
      const current = calls.get(index) || { id: '', name: '', arguments: '' };
      if (piece.id) current.id = piece.id;
      if (piece.function?.name) current.name += piece.function.name;
      if (piece.function?.arguments) current.arguments += piece.function.arguments;
      calls.set(index, current);
    }
  });
  const toolCalls = [...calls.values()].map((c, i) => ({
    id: c.id || `call_${Date.now()}_${i}`,
    name: c.name,
    arguments: safeJsonArgs(c.arguments),
  })).filter((c) => c.name);
  return { text, toolCalls, usage, finish, streamed: true };
}

function anthropicMessages(frames) {
  const out = [];
  for (const f of frames) {
    if (f.role === 'user') {
      const blocks = [];
      if (f.content) blocks.push({ type: 'text', text: f.content });
      for (const item of f.media || []) {
        const parsed = parseDataUrl(item.dataUrl);
        if (!parsed) continue;
        if (parsed.mediaType.startsWith('image/')) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } });
        } else if (parsed.mediaType === 'application/pdf') {
          blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: parsed.data } });
        } else blocks.push({ type: 'text', text: mediaNote(item) + ' The file is available in the workspace.' });
      }
      out.push({ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (f.role === 'assistant') {
      const blocks = [];
      if (f.content) blocks.push({ type: 'text', text: f.content });
      for (const c of f.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {} });
      out.push({ role: 'assistant', content: blocks });
    } else if (f.role === 'tool') {
      const prev = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: f.callId, content: f.content, is_error: Boolean(f.isError) };
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content.every((x) => x.type === 'tool_result')) prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

async function callAnthropic(resolved, { system, frames, tools, signal, onTextDelta }) {
  const url = wrapProviderUrl(`${resolved.spec.baseURL.replace(/\/$/, '')}/messages`);
  if (!resolved.trustedBaseURL) await assertSafeExternalUrl(url);
  const request = { model: resolved.modelId, max_tokens: 8192, system, messages: anthropicMessages(frames), tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) };
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': resolved.key, 'anthropic-version': '2023-06-01' };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(request) }, signal);
    const content = Array.isArray(body?.content) ? body.content : [];
    return {
      text: content.filter((b) => b.type === 'text').map((b) => b.text || '').join(''),
      toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
      usage: body?.usage || null,
      finish: body?.stop_reason || null,
      streamed: false,
    };
  }

  let text = '';
  let usage = null;
  let finish = null;
  const calls = new Map();
  await fetchSse(url, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) }, signal, (event) => {
    if (event?.type === 'message_start' && event.message?.usage) usage = event.message.usage;
    if (event?.type === 'message_delta') {
      if (event.delta?.stop_reason) finish = event.delta.stop_reason;
      if (event.usage) usage = { ...(usage || {}), ...event.usage };
    }
    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, baseInput: event.content_block.input || {}, partial: '' });
    }
    if (event?.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        text += event.delta.text;
        onTextDelta(event.delta.text);
      }
      if (event.delta?.type === 'input_json_delta') {
        const current = calls.get(event.index) || { id: `call_${Date.now()}_${event.index}`, name: '', baseInput: {}, partial: '' };
        current.partial += event.delta.partial_json || '';
        calls.set(event.index, current);
      }
    }
  });
  const toolCalls = [...calls.values()].map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.partial ? safeJsonArgs(c.partial) : c.baseInput || {},
  })).filter((c) => c.name);
  return { text, toolCalls, usage, finish, streamed: true };
}

function geminiContents(frames) {
  const out = [];
  for (const f of frames) {
    if (f.role === 'user') {
      const parts = [];
      if (f.content) parts.push({ text: f.content });
      for (const item of f.media || []) {
        const parsed = parseDataUrl(item.dataUrl);
        if (parsed && (parsed.mediaType.startsWith('image/') || parsed.mediaType === 'application/pdf')) {
          parts.push({ inlineData: { mimeType: parsed.mediaType, data: parsed.data } });
        } else parts.push({ text: mediaNote(item) + ' The file is available in the workspace.' });
      }
      out.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
    } else if (f.role === 'assistant') {
      const parts = [];
      if (f.content) parts.push({ text: f.content });
      for (const c of f.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.arguments || {} } });
      out.push({ role: 'model', parts });
    } else if (f.role === 'tool') {
      const part = { functionResponse: { name: f.name, response: { result: f.content, ...(f.isError ? { error: true } : {}) } } };
      const prev = out[out.length - 1];
      if (prev?.role === 'user' && prev.parts?.some((p) => p.functionResponse)) prev.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
    }
  }
  return out;
}

async function callGoogle(resolved, { system, frames, tools, signal, onTextDelta }) {
  const base = resolved.spec.baseURL.replace(/\/$/, '');
  const suffix = typeof onTextDelta === 'function' ? 'streamGenerateContent' : 'generateContent';
  const url = wrapProviderUrl(`${base}/models/${encodeURIComponent(resolved.modelId)}:${suffix}?${typeof onTextDelta === 'function' ? 'alt=sse&' : ''}key=${encodeURIComponent(resolved.key)}`);
  if (!resolved.trustedBaseURL) await assertSafeExternalUrl(url);
  const request = {
    systemInstruction: { parts: [{ text: system }] },
    contents: geminiContents(frames),
    tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }],
    generationConfig: { maxOutputTokens: 8192 },
  };
  const headers = { 'content-type': 'application/json', accept: typeof onTextDelta === 'function' ? 'text/event-stream' : 'application/json' };
  const consume = (body, state) => {
    const candidate = body?.candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason) state.finish = candidate.finishReason;
    if (body?.usageMetadata) state.usage = body.usageMetadata;
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === 'string' && part.text) {
        state.text += part.text;
        onTextDelta?.(part.text);
      }
      if (part.functionCall?.name) state.calls.push({ id: `gcall_${Date.now()}_${state.calls.length}`, name: part.functionCall.name, arguments: part.functionCall.args || {} });
    }
  };
  const state = { text: '', calls: [], usage: null, finish: null };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(request) }, signal);
    consume(body, state);
    return { text: state.text, toolCalls: state.calls, usage: state.usage, finish: state.finish, streamed: false };
  }
  await fetchSse(url, { method: 'POST', headers, body: JSON.stringify(request) }, signal, (event) => consume(event, state));
  return { text: state.text, toolCalls: state.calls, usage: state.usage, finish: state.finish, streamed: true };
}

export async function callModel(ownerId, model, request) {
  const resolved = resolveModel(ownerId, model);
  if (resolved.spec.kind === 'anthropic') return callAnthropic(resolved, request);
  if (resolved.spec.kind === 'google') return callGoogle(resolved, request);
  return callOpenAI(resolved, request);
}

export async function probeModel(ownerId, providerId, { modelId, baseUrl = null }) {
  const start = Date.now();
  const spec = effectiveSpecs(ownerId)[providerId];
  const key = getProviderKey(ownerId, providerId);
  if (!spec || spec.enabled === false || !key) return { available: false, latencyMs: Date.now() - start, checkedAt: Date.now(), error: 'API key не настроен или провайдер выключен' };
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
      ? await callAnthropic(resolved, { system: 'Reply with OK.', frames: [{ role:'user',content:'OK' }], tools: pingTools })
      : resolved.spec.kind === 'google'
        ? await callGoogle(resolved, { system: 'Reply with OK.', frames: [{ role:'user',content:'OK' }], tools: pingTools })
        : await callOpenAI(resolved, { system: 'Reply with OK.', frames: [{ role:'user',content:'OK' }], tools: pingTools });
    return { available: Boolean(result.text || result.finish), latencyMs: Date.now() - start, checkedAt: Date.now() };
  } catch (err) {
    return { available: false, latencyMs: Date.now() - start, checkedAt: Date.now(), error: err.message };
  }
}
