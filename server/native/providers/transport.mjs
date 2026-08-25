import { PROVIDER_STREAM_HARD_MS, PROVIDER_STREAM_IDLE_MS } from '../config.mjs';
import { assertSafeExternalUrl, isLoopbackOrPrivateHost, safeExternalFetch } from '../security.mjs';

const reqTimeout = 30_000;

export function normalizeRelayBase(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
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

export const RELAY_BASE = normalizeRelayBase(process.env.Z_AGENT_RELAY_URL);
export const RELAY_ENABLED = Boolean(RELAY_BASE);

export function relayStatus() {
  return { enabled: RELAY_ENABLED, host: RELAY_ENABLED ? new URL(RELAY_BASE).host : null };
}

export function wrapProviderUrl(url) {
  if (!RELAY_ENABLED) return url;
  try {
    const parsed = new URL(url);
    if (parsed.host === new URL(RELAY_BASE).host) return url;
    if (parsed.protocol !== 'https:') return url;
    if (isLoopbackOrPrivateHost(parsed.hostname)) return url;
    const stripped = url.replace(/^https?:\/\//, '');
    return `${RELAY_BASE}/${stripped}`;
  } catch {
    return url;
  }
}

export function timeoutSignal(ms = reqTimeout, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    },
  };
}

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

export function classifyWatchdogAbort(err, watchdog, outerSignal) {
  if (err?.name === 'AbortError' && watchdog.signal.aborted && !outerSignal?.aborted) {
    return Object.assign(new Error('Provider stream timed out (idle or hard ceiling)'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
    });
  }
  return err;
}

export function parseRetryAfterMs(res) {
  const raw = res?.headers?.get?.('retry-after');
  if (raw == null || String(raw).trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

export function providerError(res, text, body = null) {
  const message = body?.error?.message || body?.message || String(text || '').slice(0, 500) || `${res.status} ${res.statusText}`;
  const err = new Error(message);
  err.statusCode = res.status;
  err.body = body;
  err.providerResponse = true;
  const retryAfterMs = parseRetryAfterMs(res);
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  return err;
}

export function transientStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export const RATE_LIMIT_RE = /rate limit|too many requests|try again later|temporarily overloaded|overloaded|error from provider \(console\)/i;
export const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000, 45_000, 60_000, 60_000];
export const RATE_LIMIT_EXTRA_RETRIES = 4;
export const RATE_LIMIT_MAX_WAIT_MS = 60_000;

export function isRateLimitProviderError(err) {
  if (Number(err?.statusCode) === 429) return true;
  const message = `${err?.code || ''} ${err?.message || ''} ${JSON.stringify(err?.body || '')}`;
  return RATE_LIMIT_RE.test(message);
}

export const NETWORK_TRANSPORT_RE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|EPROTO|UND_ERR|ERR_SSL|ERR_SOCKET|socket hang up|network error|fetch failed|terminated|other side closed|disconnected before secure TLS|TLS connection was established|ssl routines|handshake failure/i;
export const NETWORK_EXTRA_RETRIES = 2;

export function isNetworkTransportError(err) {
  const message = `${err?.code || ''} ${err?.cause?.code || ''} ${err?.cause?.message || ''} ${err?.message || String(err || '')}`;
  return NETWORK_TRANSPORT_RE.test(message);
}

export const MODEL_UNAVAILABLE_RE = /promotion has ended|no longer available|model.{0,40}(?:not found|does not exist|unavailable|has been (?:disabled|retired|removed|deprecated))|unknown model|not a valid model|payment required|insufficient (?:credits?|quota|balance)|credit(?:s)? (?:exhausted|exceeded)|subscribe to |billing|opencode go|upstream request failed|\{\s*"model"\s*:/i;
export const PROVIDER_SALES_RE = /opencode\.ai|opencode\s+go|free promotion has ended/i;
export const PUBLIC_MODEL_UNAVAILABLE = 'Эта модель сейчас недоступна у провайдера.';

export function providerErrorText(err) {
  return `${err?.code || ''} ${err?.message || ''} ${JSON.stringify(err?.body || '')}`;
}

export function isModelUnavailableError(err) {
  const status = Number(err?.statusCode) || 0;
  if (status === 402) return true;
  return MODEL_UNAVAILABLE_RE.test(providerErrorText(err));
}

export function looksLikeOpaqueModelPayload(raw) {
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

export const PUBLIC_RATE_LIMITED = 'Провайдер ограничил частоту запросов к этой модели.';

export function rateLimitMessage(err) {
  const wait = Number(err?.retryAfterMs);
  if (Number.isFinite(wait) && wait > 0) {
    return `${PUBLIC_RATE_LIMITED} Повторите через ${Math.max(1, Math.ceil(wait / 1000))} с.`;
  }
  return `${PUBLIC_RATE_LIMITED} Это ограничение частоты, а не исчерпанный баланс: повторите чуть позже.`;
}

export function publicProviderErrorMessage(err) {
  const prepared = String(err?.publicMessage || '').trim();
  if (prepared) return prepared;
  const raw = String(err?.message || err || '').trim();
  if (isRateLimitProviderError(err) && !isModelUnavailableError(err)) return rateLimitMessage(err);
  if (isModelUnavailableError(err) || PROVIDER_SALES_RE.test(raw) || looksLikeOpaqueModelPayload(raw)) return PUBLIC_MODEL_UNAVAILABLE;
  if (/error from provider \(console\)/i.test(raw) || (raw.startsWith('{') && raw.endsWith('}'))) {
    return 'Провайдер не смог завершить этот ответ.';
  }
  return raw.replace(/https?:\/\/\S*opencode\S*/gi, '').trim() || 'Провайдер не смог завершить этот ответ.';
}

export function isTransientProviderError(err, outerSignal) {
  if (outerSignal?.aborted) return false;
  if (isRateLimitProviderError(err)) return true;
  if (transientStatus(Number(err?.statusCode))) return true;
  if (Number(err?.statusCode) > 0) return false;
  if (isNetworkTransportError(err)) return true;
  return err?.name === 'AbortError';
}

export function retrySleepMs(err, attempt) {
  if (isRateLimitProviderError(err)) {
    const hinted = Number(err?.retryAfterMs);
    const fallback = RATE_LIMIT_BACKOFF_MS[Math.min(Math.max(0, attempt), RATE_LIMIT_BACKOFF_MS.length - 1)];
    const wait = Number.isFinite(hinted) && hinted >= 0 ? hinted : fallback;
    return Math.min(RATE_LIMIT_MAX_WAIT_MS, wait);
  }
  return Math.min(2000, 250 * (2 ** attempt) + Math.floor(Math.random() * 150));
}

export function grantRateLimitRetry(err, state) {
  if (!isRateLimitProviderError(err) || state.rateLimitExtra <= 0) return false;
  if (state.failFastRateLimit) return false;
  state.rateLimitExtra -= 1;
  if (state.attemptsLeft < 1) state.attemptsLeft = 1;
  return true;
}

export function grantNetworkRetry(err, state) {
  if (!isNetworkTransportError(err) || state.networkExtra <= 0) return false;
  state.networkExtra -= 1;
  if (state.attemptsLeft < 1) state.attemptsLeft = 1;
  return true;
}

export function sleep(ms, signal) {
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

export let providerTransportOverride = null;
export function setProviderTransportForTests(fn) {
  providerTransportOverride = typeof fn === 'function' ? fn : null;
}

export async function providerFetch(target, init) {
  if (providerTransportOverride) return await providerTransportOverride(target.url, init, target);
  return target.pinned ? await safeExternalFetch(target.url, init) : await fetch(target.url, init);
}

export async function fetchJson(target, init, outerSignal, { retries = 2, failFastRateLimit = false, timeoutMs = reqTimeout } = {}) {
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
    const t = timeoutSignal(timeoutMs, outerSignal);
    try {
      const res = await providerFetch(current, { ...init, signal: t.signal });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
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

export async function fetchSse(target, init, outerSignal, onEvent, { retries = 2, failFastRateLimit = false } = {}) {
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

export function providerAuth(spec, key) {
  if (spec.kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (spec.kind === 'google') return { 'x-goog-api-key': key };
  return { authorization: `Bearer ${key}` };
}

export async function assertSafeProviderUrl(value) {
  const url = await assertSafeExternalUrl(value);
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('Provider endpoints must use HTTPS'), { statusCode: 400 });
  }
  return url;
}

export async function routedProviderTarget(directUrl, trustedBaseURL) {
  if (!trustedBaseURL) await assertSafeProviderUrl(directUrl);
  const relayed = wrapProviderUrl(directUrl);
  const directTarget = { url: directUrl, pinned: !trustedBaseURL };
  if (relayed === directUrl) return directTarget;
  const relayTarget = { url: relayed, pinned: true };
  return { ...relayTarget, fallback: directTarget };
}
