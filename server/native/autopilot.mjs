import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MAX_AGENT_STEPS, MAX_AGENT_STEPS_CEILING } from './config.mjs';
import { buildCatalog, callModel as callProviderModel, isModelUnavailableError, isNetworkTransportError } from './providers.mjs';

const HEALTH_FILE = path.join(DATA_DIR, 'autopilot-model-health.json');
const MAX_CANDIDATES = 5;
let healthCache = null;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function healthState() {
  if (!healthCache) healthCache = readJson(HEALTH_FILE, {}) || {};
  return healthCache;
}

function ownerKey(ownerId) {
  return crypto.createHash('sha256').update(String(ownerId || '')).digest('hex').slice(0, 20);
}

export function modelKey(model) {
  return `${String(model?.providerID || '')}/${String(model?.modelID || '')}`;
}

function healthKey(ownerId, model) {
  return `${ownerKey(ownerId)}:${modelKey(model)}`;
}

function configuredModel(value = process.env.Z_AGENT_DEFAULT_MODEL || '') {
  const text = String(value || '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0 || slash >= text.length - 1) return null;
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
}

function normalizeCandidate(model) {
  if (!model?.providerID || !model?.modelID) return null;
  return {
    providerID: String(model.providerID),
    modelID: String(model.modelID),
    providerName: model.providerName ? String(model.providerName) : undefined,
    modelName: model.modelName ? String(model.modelName) : undefined,
    status: model.status ? String(model.status) : undefined,
    source: model.source ? String(model.source) : undefined,
    free: Boolean(model.free),
  };
}

function complexityHint(goal) {
  const text = String(goal || '').toLowerCase();
  if (!text) return 0;
  let score = Math.min(3, Math.floor(text.length / 1200));
  if (/(архитект|architecture|миграц|migration|рефактор|refactor|end[- ]to[- ]end|полностью|whole project|весь проект|security|безопасност)/i.test(text)) score += 2;
  if (/(несколько файлов|multiple files|across the repo|во всём репозитории|production|продакш)/i.test(text)) score += 1;
  return Math.min(5, score);
}

/** Pure deterministic ranking used by tests and the runtime. */
export function rankModelCandidates(models, requested = null, health = {}, configured = null, goal = '') {
  const requestedModel = normalizeCandidate(requested);
  const configuredCandidate = normalizeCandidate(configured);
  const unique = new Map();
  let order = 0;
  for (const raw of Array.isArray(models) ? models : []) {
    const candidate = normalizeCandidate(raw);
    if (!candidate) continue;
    const key = modelKey(candidate);
    if (!unique.has(key)) unique.set(key, { ...candidate, order: order++ });
  }
  if (configuredCandidate && !unique.has(modelKey(configuredCandidate))) unique.set(modelKey(configuredCandidate), { ...configuredCandidate, order: order++ });
  if (requestedModel && !unique.has(modelKey(requestedModel))) unique.set(modelKey(requestedModel), { ...requestedModel, order: order++ });

  const complex = complexityHint(goal);
  const requestedKey = requestedModel ? modelKey(requestedModel) : '';
  const configuredKey = configuredCandidate ? modelKey(configuredCandidate) : '';
  return [...unique.values()]
    .map((candidate) => {
      const key = modelKey(candidate);
      const h = health[key] || {};
      let score = -candidate.order;
      if (key === requestedKey) score += 1_000_000;
      else if (key === configuredKey) score += 500_000;
      if (candidate.status === 'live') score += 5_000;
      else if (candidate.status === 'cache') score += 2_500;
      score += Math.min(2_000, Number(h.successes || 0) * 35);
      score -= Math.min(8_000, Number(h.failures || 0) * 45);
      score -= Math.min(20_000, Number(h.consecutiveFailures || 0) * 900);
      if (Number(h.lastSuccessAt || 0) > Date.now() - 24 * 60 * 60 * 1000) score += 600;
      if (Number(h.lastFailureAt || 0) > Date.now() - 5 * 60 * 1000) score -= 1_500;
      if (isModelUnavailableError({ message: h.lastError })) score -= 50_000;
      const id = `${candidate.modelID} ${candidate.modelName || ''}`.toLowerCase();
      if (/\b(code|coder|coding)\b/.test(id)) score += 120;
      if (complex >= 2 && /reason|think|pro|sonnet|opus|max/.test(id)) score += 80 * complex;
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ score: _score, order: _order, ...candidate }) => candidate)
    .slice(0, MAX_CANDIDATES);
}

function ownerHealth(ownerId) {
  const prefix = `${ownerKey(ownerId)}:`;
  const out = {};
  for (const [key, value] of Object.entries(healthState())) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

function recordHealth(ownerId, model, ok, latencyMs, error = null) {
  const state = healthState();
  const key = healthKey(ownerId, model);
  const previous = state[key] || {};
  const now = Date.now();
  state[key] = {
    successes: Number(previous.successes || 0) + (ok ? 1 : 0),
    failures: Number(previous.failures || 0) + (ok ? 0 : 1),
    consecutiveFailures: ok ? 0 : Number(previous.consecutiveFailures || 0) + 1,
    lastLatencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
    lastSuccessAt: ok ? now : Number(previous.lastSuccessAt || 0),
    lastFailureAt: ok ? Number(previous.lastFailureAt || 0) : now,
    lastError: ok ? '' : String(error?.message || error || '').slice(0, 500),
  };
  try { writeJsonAtomic(HEALTH_FILE, state); } catch { /* health data must never break a turn */ }
}

export async function buildModelPlan(ownerId, requested = null, goal = '') {
  const explicit = normalizeCandidate(requested);
  if (explicit) {
    // User choice remains the zero-overhead primary path. Alternatives are
    // discovered only if that request fails before any visible output.
    return {
      candidates: [explicit],
      explicit: true,
      expandOnFailure: true,
      goal: String(goal || ''),
      generatedAt: Date.now(),
    };
  }
  const catalog = await buildCatalog(ownerId);
  const configured = configuredModel();
  const candidates = rankModelCandidates(catalog.models, null, ownerHealth(ownerId), configured, goal);
  if (!candidates.length) throw Object.assign(new Error('Нет доступной модели. Добавьте API key в Настройки → Провайдеры.'), { statusCode: 400 });
  return { candidates, explicit: false, expandOnFailure: false, goal: String(goal || ''), generatedAt: Date.now() };
}

export function fallbackEligible(error, { strict = false } = {}) {
  if (error?.name === 'AbortError') return false;
  if (isNetworkTransportError(error) || isModelUnavailableError(error)) return true;
  const status = Number(error?.statusCode) || 0;
  if (!status) return true;
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  if (!strict && [401, 403, 404].includes(status)) return true;
  return false;
}

/**
 * Execute candidates in order. Once visible streaming output has been emitted,
 * switching models is forbidden: mixing two providers into one assistant
 * answer is worse than surfacing the original failure.
 */
export async function runFallbackPlan(plan, request, invoke, options = {}) {
  const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
  if (!candidates.length) throw new Error('Autopilot model plan is empty');
  const attempts = [];
  let lastError = null;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    let emitted = false;
    const startedAt = Date.now();
    const originalDelta = request?.onTextDelta;
    const wrappedRequest = {
      ...request,
      ...(typeof originalDelta === 'function'
        ? { onTextDelta(delta) { emitted = true; originalDelta(delta); } }
        : {}),
    };
    try {
      const response = await invoke(candidate, wrappedRequest, index);
      attempts.push({ model: candidate, ok: true, latencyMs: Date.now() - startedAt });
      options.onAttempt?.(attempts.at(-1));
      return { ...response, model: candidate, attempts };
    } catch (error) {
      lastError = error;
      const attempt = { model: candidate, ok: false, latencyMs: Date.now() - startedAt, error };
      attempts.push(attempt);
      options.onAttempt?.(attempt);
      const strict = Boolean(plan?.explicit && index === 0);
      if (emitted || index >= candidates.length - 1 || !fallbackEligible(error, { strict })) {
        error.autopilotEmitted = emitted;
        error.autopilotAttempts = attempts.map((item) => ({ model: item.model, ok: item.ok, latencyMs: item.latencyMs, error: item.ok ? '' : String(item.error?.message || item.error || '') }));
        throw error;
      }
    }
  }
  throw lastError || new Error('All Autopilot model candidates failed');
}

async function expandedPlan(ownerId, plan) {
  const catalog = await buildCatalog(ownerId);
  const primary = plan.candidates?.[0] || null;
  const candidates = rankModelCandidates(catalog.models, primary, ownerHealth(ownerId), configuredModel(), plan.goal || '');
  return {
    ...plan,
    explicit: false,
    expandOnFailure: false,
    candidates,
    generatedAt: Date.now(),
  };
}

function healthRecorder(ownerId) {
  return {
    onAttempt(attempt) {
      recordHealth(ownerId, attempt.model, attempt.ok, attempt.latencyMs, attempt.error);
    },
  };
}

function failFastRateLimitFor(plan, index) {
  const n = Array.isArray(plan?.candidates) ? plan.candidates.length : 0;
  if (plan?.expandOnFailure) return true;
  return index < n - 1;
}

export async function callModelAutopilot(ownerId, plan, request) {
  try {
    return await runFallbackPlan(
      plan,
      request,
      (candidate, wrappedRequest, index) => callProviderModel(ownerId, candidate, {
        ...wrappedRequest,
        failFastRateLimit: failFastRateLimitFor(plan, index),
      }),
      healthRecorder(ownerId),
    );
  } catch (error) {
    const canExpand = Boolean(
      plan?.expandOnFailure &&
      !error?.autopilotEmitted &&
      fallbackEligible(error, { strict: true }),
    );
    if (!canExpand) throw error;
    const expanded = await expandedPlan(ownerId, plan);
    const primaryKey = modelKey(plan.candidates?.[0]);
    expanded.candidates = expanded.candidates.filter((candidate) => modelKey(candidate) !== primaryKey);
    if (!expanded.candidates.length) throw error;
    const fallback = await runFallbackPlan(
      expanded,
      request,
      (candidate, wrappedRequest, index) => callProviderModel(ownerId, candidate, {
        ...wrappedRequest,
        failFastRateLimit: failFastRateLimitFor(expanded, index),
      }),
      healthRecorder(ownerId),
    );
    return {
      ...fallback,
      attempts: [...(error.autopilotAttempts || []), ...(fallback.attempts || [])],
    };
  }
}

export function promoteModelPlan(plan, selected) {
  const key = modelKey(selected);
  const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
  const hit = candidates.find((candidate) => modelKey(candidate) === key) || normalizeCandidate(selected);
  if (!hit) return plan;
  return {
    ...plan,
    explicit: false,
    expandOnFailure: false,
    candidates: [hit, ...candidates.filter((candidate) => modelKey(candidate) !== key)],
  };
}

export function taskStepBudget(goal, configured = MAX_AGENT_STEPS) {
  // Z_AGENT_MAX_STEPS pins the budget exactly; otherwise it is derived from task
  // complexity and clamped by the same ceiling. MAX_AGENT_STEPS was exported by
  // config.mjs but never read by anything.
  const explicit = Number(configured);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(MAX_AGENT_STEPS_CEILING, Math.max(1, Math.floor(explicit)));
  const complexity = complexityHint(goal);
  if (complexity >= 4) return Math.min(MAX_AGENT_STEPS_CEILING, 72);
  if (complexity >= 2) return Math.min(MAX_AGENT_STEPS_CEILING, 52);
  return Math.min(MAX_AGENT_STEPS_CEILING, 36);
}

export function subagentStepBudget(profile, goal, configured = process.env.Z_AGENT_SUBAGENT_STEPS) {
  const explicit = Number(configured);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(36, Math.max(2, Math.floor(explicit)));
  const base = Math.max(2, Number(profile?.maxSteps) || 12);
  return Math.min(30, base + complexityHint(goal) * 2);
}
