import { PROVIDER_STREAM_HARD_MS, PROVIDER_STREAM_IDLE_MS } from './config.mjs';
import { assertSafeExternalUrl, isLoopbackOrPrivateHost, safeExternalFetch } from './security.mjs';
import { getProviderKey, listHiddenModels, listManualModels } from './store.mjs';
import { listProviderConfigs } from './provider-configs.mjs';
import { createReasoningSplitter } from './reasoning-stream.mjs';



const FIXTURE_PROVIDER_ID = 'fixture';
const FIXTURE_MODEL_ID = 'coding-e2e';

function fixtureProviderEnabled() {
  return process.env.Z_AGENT_ENABLE_FIXTURE_PROVIDER === '1';
}

function fixtureToolCount(frames, name) {
  return (Array.isArray(frames) ? frames : []).filter((frame) => frame?.role === 'tool' && frame?.name === name && !frame?.isError).length;
}

function fixturePrompt(frames) {
  return (Array.isArray(frames) ? frames : []).filter((frame) => frame?.role === 'user').map((frame) => String(frame?.content || '')).join('\n');
}

function fixtureResponse(request) {
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

  // Фикстура отдаёт готовый ответ: помечаем его текстом явно, чтобы живой
  // разбор не принял английский текст фикстуры за монолог модели.
  if (typeof request?.onTextDelta === 'function' && response.text) request.onTextDelta(response.text, 'text');
  return { ...response, usage: { prompt_tokens: 16, completion_tokens: 12 }, streamed: typeof request?.onTextDelta === 'function' };
}

// --- Optional relay wrapper (opt-in, off by default) ---
// When Z_AGENT_RELAY_URL is set, external provider URLs are routed through that
// relay. The relay therefore terminates TLS and observes provider API keys and
// full prompt bodies, so it must be an HTTPS endpoint the operator controls.
// It is intentionally empty by default: no traffic leaves for a third party
// unless the operator opts in.
function normalizeRelayBase(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch {
    console.warn('[providers] Z_AGENT_RELAY_URL is not a valid URL; relay disabled.');
    return '';
  }
  if (parsed.protocol !== 'https:') {
    console.warn('[providers] Z_AGENT_RELAY_URL must use https; relay disabled.');
    return '';
  }
  if (isLoopbackOrPrivateHost(parsed.hostname)) {
    console.warn('[providers] Z_AGENT_RELAY_URL points at a local/private host; relay disabled.');
    return '';
  }
  console.warn('[providers] Provider traffic is routed through Z_AGENT_RELAY_URL. That host will observe provider API keys and prompt bodies.');
  return value;
}

const RELAY_BASE = normalizeRelayBase(process.env.Z_AGENT_RELAY_URL);
const RELAY_ENABLED = Boolean(RELAY_BASE);

export function relayStatus() {
  return { enabled: RELAY_ENABLED, host: RELAY_ENABLED ? new URL(RELAY_BASE).host : null };
}

function wrapProviderUrl(url) {
  if (!RELAY_ENABLED) return url;
  try {
    const parsed = new URL(url);
    if (parsed.host === new URL(RELAY_BASE).host) return url;
    // Never downgrade provider TLS through the relay path, and never relay a
    // destination that is already local to this runtime.
    if (parsed.protocol !== 'https:') return url;
    if (isLoopbackOrPrivateHost(parsed.hostname)) return url;
    const stripped = url.replace(/^https?:\/\//, '');
    return `${RELAY_BASE}/${stripped}`;
  } catch {
    return url;
  }
}
// --- /Optional relay wrapper ---

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
  const rows = Object.entries(effectiveSpecs(ownerId)).map(([id, spec]) => ({
    id,
    name: spec.name,
    protocol: spec.kind,
    baseURL: spec.baseURL,
    enabled: spec.enabled !== false,
    custom: Boolean(spec.custom),
    models: {},
  }));
  if (fixtureProviderEnabled()) rows.unshift({ id: FIXTURE_PROVIDER_ID, name: 'Deterministic Fixture', protocol: 'fixture', baseURL: '', enabled: true, custom: false, models: {} });
  return rows;
}

function timeoutSignal(ms = reqTimeout, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  return { signal: controller.signal, cleanup() { clearTimeout(timer); outerSignal?.removeEventListener('abort', onAbort); } };
}

// Wall-clock abort kills a healthy 10-minute reasoning stream. Abort only
// after idleMs of silence, with a hard ceiling so a wedged socket cannot
// pin a turn forever.
export function idleTimeoutSignal({ idleMs, hardMs, outerSignal, pollMs = 2_000 }) {
  const controller = new AbortController();
  let lastActivity = Date.now();
  const started = Date.now();
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - started >= hardMs || now - lastActivity >= idleMs) controller.abort();
  }, Math.max(20, Number(pollMs) || 2_000));
  timer.unref?.();
  return {
    signal: controller.signal,
    touch() { lastActivity = Date.now(); },
    cleanup() {
      clearInterval(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function classifyWatchdogAbort(err, watchdog, outerSignal) {
  if (err?.name === 'AbortError' && watchdog.signal.aborted && !outerSignal?.aborted) {
    return Object.assign(new Error('Provider stream timed out (idle or hard ceiling)'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
    });
  }
  return err;
}

function parseRetryAfterMs(res) {
  const raw = res?.headers?.get?.('retry-after');
  if (raw == null || String(raw).trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function providerError(res, text, body = null) {
  const message = body?.error?.message || body?.message || String(text || '').slice(0, 500) || `${res.status} ${res.statusText}`;
  const err = new Error(message);
  err.statusCode = res.status;
  err.body = body;
  err.providerResponse = true;
  const retryAfterMs = parseRetryAfterMs(res);
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  return err;
}

function transientStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const RATE_LIMIT_RE = /rate limit|too many requests|try again later|temporarily overloaded|overloaded|error from provider \(console\)/i;
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000, 45_000, 60_000, 60_000];
const RATE_LIMIT_EXTRA_RETRIES = 4;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

export function isRateLimitProviderError(err) {
  if (Number(err?.statusCode) === 429) return true;
  const message = `${err?.code || ''} ${err?.message || ''} ${JSON.stringify(err?.body || '')}`;
  return RATE_LIMIT_RE.test(message);
}

const NETWORK_TRANSPORT_RE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|EPROTO|UND_ERR|ERR_SSL|ERR_SOCKET|socket hang up|network error|fetch failed|terminated|other side closed|disconnected before secure TLS|TLS connection was established|ssl routines|handshake failure/i;
const NETWORK_EXTRA_RETRIES = 2;

export function isNetworkTransportError(err) {
  const message = `${err?.code || ''} ${err?.cause?.code || ''} ${err?.cause?.message || ''} ${err?.message || String(err || '')}`;
  return NETWORK_TRANSPORT_RE.test(message);
}

const MODEL_UNAVAILABLE_RE = /promotion has ended|no longer available|model.{0,40}(?:not found|does not exist|unavailable|has been (?:disabled|retired|removed|deprecated))|unknown model|not a valid model|payment required|insufficient (?:credits?|quota|balance)|credit(?:s)? (?:exhausted|exceeded)|subscribe to |billing|opencode go|upstream request failed|\{\s*"model"\s*:/i;
const PROVIDER_SALES_RE = /opencode\.ai|opencode\s+go|free promotion has ended/i;
const PUBLIC_MODEL_UNAVAILABLE = 'Эта модель сейчас недоступна у провайдера.';

function providerErrorText(err) {
  return `${err?.code || ''} ${err?.message || ''} ${JSON.stringify(err?.body || '')}`;
}

/** This specific model is retired, unpaid, or a ended free SKU. Try another. */
export function isModelUnavailableError(err) {
  const status = Number(err?.statusCode) || 0;
  if (status === 402) return true;
  return MODEL_UNAVAILABLE_RE.test(providerErrorText(err));
}

function looksLikeOpaqueModelPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  const json = text.startsWith('{') ? text : (/\{\s*"model"\s*:[\s\S]*\}/.exec(text) || [])[0];
  if (!json) return false;
  try {
    const parsed = JSON.parse(json);
    return Boolean(parsed && typeof parsed === 'object' && typeof parsed.model === 'string' && !parsed.error && !parsed.message);
  } catch {
    return false;
  }
}

const PUBLIC_RATE_LIMITED = 'Провайдер ограничил частоту запросов к этой модели.';

/**
 * 429 — это «слишком часто прямо сейчас», а не «модель закончилась».
 * У бесплатных моделей почти всегда есть потолок запросов в минуту или в
 * сутки, и сырой текст провайдера («limits exceeded») читался как отключение
 * модели или как исчерпанный баланс. Называем вещи своими именами и
 * подсказываем время ожидания, если провайдер его прислал.
 */
function rateLimitMessage(err) {
  const wait = Number(err?.retryAfterMs);
  if (Number.isFinite(wait) && wait > 0) {
    return `${PUBLIC_RATE_LIMITED} Повторите через ${Math.max(1, Math.ceil(wait / 1000))} с.`;
  }
  return `${PUBLIC_RATE_LIMITED} Это ограничение частоты, а не исчерпанный баланс: повторите чуть позже.`;
}

/** User-visible provider failures must not advertise a third-party product. */
export function publicProviderErrorMessage(err) {
  // Готовое объяснение (например «модель выбрана вручную и отказала потому
  // что …») точнее generic-маскировки ниже, поэтому имеет приоритет.
  const prepared = String(err?.publicMessage || '').trim();
  if (prepared) return prepared;
  const raw = String(err?.message || err || '').trim();
  // Проверка на исчерпанный баланс идёт раньше: OpenAI отдаёт
  // insufficient_quota тоже с кодом 429, а это уже не частота.
  if (isRateLimitProviderError(err) && !isModelUnavailableError(err)) return rateLimitMessage(err);
  if (isModelUnavailableError(err) || PROVIDER_SALES_RE.test(raw) || looksLikeOpaqueModelPayload(raw)) return PUBLIC_MODEL_UNAVAILABLE;
  if (/error from provider \(console\)/i.test(raw) || (raw.startsWith('{') && raw.endsWith('}'))) {
    return 'Провайдер не смог завершить этот ответ.';
  }
  return raw.replace(/https?:\/\/\S*opencode\S*/gi, '').trim() || 'Провайдер не смог завершить этот ответ.';
}

function isTransientProviderError(err, outerSignal) {
  // User-cancelled turns must stay cancelled. A timer abort (no outer abort)
  // is a dropped socket and is worth another try.
  if (outerSignal?.aborted) return false;
  if (isRateLimitProviderError(err)) return true;
  if (transientStatus(Number(err?.statusCode))) return true;
  if (Number(err?.statusCode) > 0) return false;
  if (isNetworkTransportError(err)) return true;
  return err?.name === 'AbortError';
}

function retrySleepMs(err, attempt) {
  if (isRateLimitProviderError(err)) {
    const hinted = Number(err?.retryAfterMs);
    const fallback = RATE_LIMIT_BACKOFF_MS[Math.min(Math.max(0, attempt), RATE_LIMIT_BACKOFF_MS.length - 1)];
    const wait = Number.isFinite(hinted) && hinted >= 0 ? hinted : fallback;
    return Math.min(RATE_LIMIT_MAX_WAIT_MS, wait);
  }
  return Math.min(2000, 250 * (2 ** attempt) + Math.floor(Math.random() * 150));
}

function grantRateLimitRetry(err, state) {
  if (!isRateLimitProviderError(err) || state.rateLimitExtra <= 0) return false;
  // Autopilot can switch models. Sitting 3–4 minutes on one 429 is worse
  // than failing this candidate immediately.
  if (state.failFastRateLimit) return false;
  state.rateLimitExtra -= 1;
  if (state.attemptsLeft < 1) state.attemptsLeft = 1;
  return true;
}

function grantNetworkRetry(err, state) {
  if (!isNetworkTransportError(err) || state.networkExtra <= 0) return false;
  state.networkExtra -= 1;
  if (state.attemptsLeft < 1) state.attemptsLeft = 1;
  return true;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let providerTransportOverride = null;
export function setProviderTransportForTests(fn) {
  providerTransportOverride = typeof fn === 'function' ? fn : null;
}

async function providerFetch(target, init) {
  if (providerTransportOverride) return await providerTransportOverride(target.url, init, target);
  return target.pinned ? await safeExternalFetch(target.url, init) : await fetch(target.url, init);
}

async function fetchJson(target, init, outerSignal, { retries = 2, failFastRateLimit = false } = {}) {
  let lastError = null;
  let current = { url: target.url, pinned: target.pinned };
  let fallback = target.fallback || null;
  const state = {
    attemptsLeft: retries + 1,
    rateLimitExtra: failFastRateLimit ? 0 : RATE_LIMIT_EXTRA_RETRIES,
    networkExtra: NETWORK_EXTRA_RETRIES,
    failFastRateLimit,
  };
  let attempt = 0;
  while (state.attemptsLeft > 0) {
    state.attemptsLeft -= 1;
    const t = timeoutSignal(reqTimeout, outerSignal);
    try {
      const res = await providerFetch(current, { ...init, signal: t.signal });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
      if (!res.ok) throw providerError(res, text, body);
      if (body === null && text) throw new Error('Provider returned non-JSON response');
      return body;
    } catch (err) {
      lastError = classifyWatchdogAbort(err, t, outerSignal);
      if (!isTransientProviderError(lastError, outerSignal)) throw lastError;
      if (state.failFastRateLimit && isRateLimitProviderError(lastError)) throw lastError;
      if (fallback) {
        current = fallback;
        fallback = null;
        if (state.attemptsLeft < 1) state.attemptsLeft = 1;
      } else if (state.attemptsLeft < 1 && !grantRateLimitRetry(lastError, state) && !grantNetworkRetry(lastError, state)) {
        throw lastError;
      }
    } finally {
      t.cleanup();
    }
    if (state.attemptsLeft > 0) {
      await sleep(retrySleepMs(lastError, attempt), outerSignal);
      attempt += 1;
    }
  }
  throw lastError || new Error('Provider request failed');
}

async function fetchSse(target, init, outerSignal, onEvent, { retries = 2, failFastRateLimit = false } = {}) {
  let lastError = null;
  let current = { url: target.url, pinned: target.pinned };
  let fallback = target.fallback || null;
  const state = {
    attemptsLeft: retries + 1,
    rateLimitExtra: failFastRateLimit ? 0 : RATE_LIMIT_EXTRA_RETRIES,
    networkExtra: NETWORK_EXTRA_RETRIES,
    failFastRateLimit,
  };
  let attempt = 0;
  while (state.attemptsLeft > 0) {
    state.attemptsLeft -= 1;
    let received = 0;
    const t = idleTimeoutSignal({
      idleMs: PROVIDER_STREAM_IDLE_MS,
      hardMs: PROVIDER_STREAM_HARD_MS,
      outerSignal,
    });
    try {
      const res = await providerFetch(current, { ...init, signal: t.signal });
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
        try {
          const event = JSON.parse(raw);
          received += 1;
          onEvent(event);
        } catch (err) {
          if (err instanceof SyntaxError) return;
          throw err;
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (value?.byteLength) t.touch();
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
      return;
    } catch (err) {
      lastError = classifyWatchdogAbort(err, t, outerSignal);
      // Mid-stream reset: keep the tokens/tool calls already delivered instead
      // of aborting a turn that already made progress.
      if (received > 0 && isTransientProviderError(lastError, outerSignal)) return;
      if (!isTransientProviderError(lastError, outerSignal)) throw lastError;
      if (state.failFastRateLimit && isRateLimitProviderError(lastError)) throw lastError;
      if (fallback) {
        current = fallback;
        fallback = null;
        if (state.attemptsLeft < 1) state.attemptsLeft = 1;
      } else if (state.attemptsLeft < 1 && !grantRateLimitRetry(lastError, state) && !grantNetworkRetry(lastError, state)) {
        throw lastError;
      }
    } finally {
      t.cleanup();
    }
    if (state.attemptsLeft > 0) {
      await sleep(retrySleepMs(lastError, attempt), outerSignal);
      attempt += 1;
    }
  }
  throw lastError || new Error('Provider stream failed');
}

function providerAuth(spec, key) {
  if (spec.kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  // The key used to travel in the query string, where it ends up in relay and
  // proxy access logs, in Referer headers and in crash reports. Google accepts
  // the same credential as a header, so it stays inside the TLS session.
  if (spec.kind === 'google') return { 'x-goog-api-key': key };
  return { authorization: `Bearer ${key}` };
}

async function assertSafeProviderUrl(value) {
  const url = await assertSafeExternalUrl(value);
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('Provider endpoints must use HTTPS'), { statusCode: 400 });
  }
  return url;
}

async function routedProviderTarget(directUrl, trustedBaseURL, { preferDirect = false } = {}) {
  // Validate the user-controlled destination before a trusted relay hides the
  // original host from the SSRF guard.
  if (!trustedBaseURL) await assertSafeProviderUrl(directUrl);
  const relayed = wrapProviderUrl(directUrl);
  const directTarget = { url: directUrl, pinned: !trustedBaseURL };
  if (relayed === directUrl) return directTarget;
  const relayTarget = { url: relayed, pinned: true };
  // Streaming a 30-minute turn through a serverless relay (Cloudflare Workers
  // typically cut HTTP at 30–100s) looks like read ECONNRESET. Prefer the
  // direct provider URL for streams; JSON catalog/probe still try the relay
  // first and fall back to direct, matching fetchModelList.
  if (preferDirect) return { ...directTarget, fallback: relayTarget };
  return { ...relayTarget, fallback: directTarget };
}

function modelListDirectUrl(spec) {
  // Every provider now authenticates through providerAuth() headers, so the
  // catalog URL no longer differs per kind.
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
      // Authentication errors returned by the provider are route-independent.
      // A local SSRF/security rejection never reaches this block.
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
    models.sort((a,b) => a.name.localeCompare(b.name));
    // Живой ответ всегда замещает прежний список целиком: снятая у
    // провайдера модель исчезает, а не домешивается к новым.
    cache.set(ck, { at: Date.now(), models });
    return { status: 'live', models, fetchedAt: Date.now() };
  } catch (err) {
    // Статус (unauthorized/unavailable) остаётся машинным сигналом для UI,
    // а текст маскируется теми же правилами, что и ошибки чата.
    const publicError = publicProviderErrorMessage(err);
    // Явное обновление обязано показать правду. Раньше сбойный запрос
    // возвращал прежний список, и снятая у провайдера модель жила в
    // настройках бесконечно: человек жал «Обновить», получал старый
    // набор и не видел причины. Кэш при этом сбрасывается, чтобы следующий
    // фоновый вызов тоже не воскресил мёртвый список.
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
    // Клиент читал catalog.hidden, но сервер это поле никогда не отдавал.
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
  const providerID = model?.providerID || '';
  const modelID = model?.modelID || '';
  if (!providerID || !modelID) throw Object.assign(new Error('Модель не выбрана'), { statusCode: 400 });
  if (providerID === FIXTURE_PROVIDER_ID) {
    if (!fixtureProviderEnabled() || modelID !== FIXTURE_MODEL_ID) throw Object.assign(new Error('Fixture model is unavailable'), { statusCode: 404 });
    return { providerId: providerID, displayProviderId: providerID, modelId: modelID, spec: { id: providerID, name: 'Deterministic Fixture', kind: 'fixture', baseURL: '', enabled: true }, key: '', trustedBaseURL: true };
  }
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
  if (!spec) throw Object.assign(new Error(`Неизв��стный провайдер: ${providerID}`), { statusCode: 400 });
  if (spec.enabled === false) throw Object.assign(new Error(`Провайдер ${spec.name} выключен`), { statusCode: 400 });
  if (!key) throw Object.assign(new Error(`API key для ${spec.name} не настроен`), { statusCode: 400 });
  return { providerId: providerID, displayProviderId: providerID, modelId: modelID, spec, key, trustedBaseURL: Boolean(spec.trustedBaseURL) };
}

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Object.hasOwn(raw, '_raw') && Object.keys(raw).length === 1) {
      return { ok: false, value: {}, raw: raw._raw };
    }
    return { ok: true, value: raw };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, value: {}, raw };
    return { ok: true, value };
  } catch {
    return { ok: false, value: {}, raw };
  }
}

export function isIncompleteToolCall(call) {
  if (call?.incomplete) return true;
  const args = call?.arguments;
  return Boolean(args && typeof args === 'object' && Object.hasOwn(args, '_raw') && Object.keys(args).length === 1);
}

function toolCallFromParsed(id, name, rawArgs) {
  const parsed = parseToolArguments(rawArgs);
  const call = { id, name, arguments: parsed.ok ? parsed.value : {} };
  if (!parsed.ok) call.incomplete = true;
  return call;
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
          else content.push({ type: 'text', text: `${mediaNote(item)} The file is available in the workspace; inspect it with tools if needed.` });
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

async function callOpenAI(resolved, { system, frames, tools, signal, onTextDelta, failFastRateLimit = false }) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/chat/completions`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL, {
    preferDirect: typeof onTextDelta === 'function',
  });
  const request = {
    model: resolved.modelId,
    messages: [{ role: 'system', content: system }, ...openAiMessages(frames)],
    ...(tools && tools.length > 0 ? {
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      tool_choice: 'auto',
    } : {}),
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${resolved.key}` };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const choice = body?.choices?.[0];
    const msg = choice?.message || {};
    const toolCalls = (msg.tool_calls || []).map((c) => toolCallFromParsed(c.id || `call_${Math.random().toString(36).slice(2)}`, c.function?.name || '', c.function?.arguments)).filter((c) => c.name);
    let contentText = typeof msg.content === 'string' ? msg.content : '';
    // Шлюзы называют поле мыслей по-разному: reasoning_content (DeepSeek),
    // reasoning (OpenRouter и совместимые), thinking.
    if (!contentText) {
      for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
        if (typeof msg[key] === 'string' && msg[key]) { contentText = msg[key]; break; }
      }
    }
    return { text: contentText, toolCalls, usage: body?.usage || null, finish: choice?.finish_reason || null, streamed: false };
  }

  // Один разделитель на весь поток: он же снимает теги <think>/<thinking>/
  // <thought>/<reasoning> и следит, чтобы мысли не попадали в ответ.
  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  const calls = new Map();
  await fetchSse(target, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) }, signal, (event) => {
    if (event?.usage) usage = event.usage;
    const choice = event?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    // Поля мыслей у совместимых API называются по-разному, а часть моделей
    // вообще присылает мысли тегами прямо в content.
    for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
      if (typeof delta[key] === 'string' && delta[key]) splitter.push(delta[key], 'reasoning');
    }
    if (typeof delta.content === 'string' && delta.content) splitter.push(delta.content, 'text');
    for (const piece of delta.tool_calls || []) {
      const index = Number.isInteger(piece.index) ? piece.index : calls.size;
      const current = calls.get(index) || { id: '', name: '', arguments: '' };
      if (piece.id) current.id = piece.id;
      if (piece.function?.name) current.name += piece.function.name;
      if (piece.function?.arguments) current.arguments += piece.function.arguments;
      calls.set(index, current);
    }
  }, { failFastRateLimit });
  splitter.flush();
  const { text: streamedText, reasoning } = splitter.snapshot();
  const toolCalls = [...calls.values()].map((c, i) => toolCallFromParsed(c.id || `call_${Date.now()}_${i}`, c.name, c.arguments)).filter((c) => c.name);
  // Модель отдала только мысли. Раньше их тут же дублировали в ленту текстом
  // (onTextDelta(reasoning, 'text')) — именно так рассуждения попадали в чат.
  // Теперь помечаем ответ флагом, а решение принимает ход в agent.mjs.
  if (!streamedText && reasoning && toolCalls.length === 0) {
    return { text: reasoning, toolCalls, usage, finish, streamed: true, textFromReasoning: true };
  }
  return { text: streamedText, toolCalls, usage, finish, streamed: true };
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
        } else blocks.push({ type: 'text', text: `${mediaNote(item)} The file is available in the workspace.` });
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

async function callAnthropic(resolved, { system, frames, tools, signal, onTextDelta, failFastRateLimit = false }) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/messages`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL, {
    preferDirect: typeof onTextDelta === 'function',
  });
  const request = { model: resolved.modelId, max_tokens: 8192, system, messages: anthropicMessages(frames), tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) };
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': resolved.key, 'anthropic-version': '2023-06-01' };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const content = Array.isArray(body?.content) ? body.content : [];
    return {
      text: content.filter((b) => b.type === 'text').map((b) => b.text || '').join(''),
      toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
      usage: body?.usage || null,
      finish: body?.stop_reason || null,
      streamed: false,
    };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  const calls = new Map();
  await fetchSse(target, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) }, signal, (event) => {
    if (event?.type === 'message_start' && event.message?.usage) usage = event.message.usage;
    if (event?.type === 'message_delta') {
      if (event.delta?.stop_reason) finish = event.delta.stop_reason;
      if (event.usage) usage = { ...(usage || {}), ...event.usage };
    }
    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, baseInput: event.content_block.input || {}, partial: '' });
    }
    if (event?.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) splitter.push(event.delta.text, 'text');
      // Extended thinking приходит отдельным родом дельты. Без этой ветки
      // мысли уходили в ленту как обычный текст.
      if (event.delta?.type === 'thinking_delta' && event.delta.thinking) splitter.push(event.delta.thinking, 'reasoning');
      if (event.delta?.type === 'input_json_delta') {
        const current = calls.get(event.index) || { id: `call_${Date.now()}_${event.index}`, name: '', baseInput: {}, partial: '' };
        current.partial += event.delta.partial_json || '';
        calls.set(event.index, current);
      }
    }
  }, { failFastRateLimit });
  splitter.flush();
  const toolCalls = [...calls.values()].map((c) => toolCallFromParsed(c.id, c.name, c.partial || c.baseInput || {})).filter((c) => c.name);
  return { text: splitter.snapshot().text, toolCalls, usage, finish, streamed: true };
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
        } else parts.push({ text: `${mediaNote(item)} The file is available in the workspace.` });
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

async function callGoogle(resolved, { system, frames, tools, signal, onTextDelta, failFastRateLimit = false }) {
  const base = resolved.spec.baseURL.replace(/\/$/, '');
  const suffix = typeof onTextDelta === 'function' ? 'streamGenerateContent' : 'generateContent';
  const directUrl = `${base}/models/${encodeURIComponent(resolved.modelId)}:${suffix}${typeof onTextDelta === 'function' ? '?alt=sse' : ''}`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL, {
    preferDirect: typeof onTextDelta === 'function',
  });
  const request = {
    systemInstruction: { parts: [{ text: system }] },
    contents: geminiContents(frames),
    tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }],
    generationConfig: { maxOutputTokens: 8192 },
  };
  // Key in a header, not in the query string: the URL is what gets logged by
  // the relay, by intermediate proxies and by our own error reporting.
  const headers = {
    'content-type': 'application/json',
    accept: typeof onTextDelta === 'function' ? 'text/event-stream' : 'application/json',
    'x-goog-api-key': resolved.key,
  };
  const splitter = typeof onTextDelta === 'function'
    ? createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind))
    : null;
  const consume = (body, state) => {
    const candidate = body?.candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason) state.finish = candidate.finishReason;
    if (body?.usageMetadata) state.usage = body.usageMetadata;
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === 'string' && part.text) {
        // Gemini помечает мысли флагом thought — в ответ модели они не входят.
        const kind = part.thought === true ? 'reasoning' : 'text';
        if (kind === 'text') state.text += part.text;
        if (splitter) splitter.push(part.text, kind);
      }
      if (part.functionCall?.name) state.calls.push({ id: `gcall_${Date.now()}_${state.calls.length}`, name: part.functionCall.name, arguments: part.functionCall.args || {} });
    }
  };
  const state = { text: '', calls: [], usage: null, finish: null };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    consume(body, state);
    return { text: state.text, toolCalls: state.calls, usage: state.usage, finish: state.finish, streamed: false };
  }
  await fetchSse(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, (event) => consume(event, state), { failFastRateLimit });
  splitter?.flush();
  return { text: splitter ? splitter.snapshot().text : state.text, toolCalls: state.calls, usage: state.usage, finish: state.finish, streamed: true };
}

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
    // Настройки — такая же пользовательская поверхность, как чат: сюда тоже
    // нельзя выносить сырой текст провайдера с рекламой или JSON-дампом.
    return { available: false, latencyMs: Date.now() - start, checkedAt: Date.now(), error: publicProviderErrorMessage(err) };
  }
}
