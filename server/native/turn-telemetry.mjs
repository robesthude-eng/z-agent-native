import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { observeTurnSummary } from './metrics.mjs';

const TELEMETRY_FILE = path.resolve(process.env.Z_AGENT_TELEMETRY_FILE || path.join(DATA_DIR, 'turn-telemetry.jsonl'));
const MAX_FILE_BYTES = Math.max(1_000_000, Number(process.env.Z_AGENT_TELEMETRY_MAX_BYTES) || 50 * 1024 * 1024);

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function usagePair(usage) {
  return {
    input: numeric(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.inputTokens ?? usage?.promptTokenCount),
    output: numeric(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.outputTokens ?? usage?.candidatesTokenCount),
  };
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(TELEMETRY_FILE).size < MAX_FILE_BYTES) return;
    const rotated = `${TELEMETRY_FILE}.1`;
    fs.rmSync(rotated, { force: true });
    fs.renameSync(TELEMETRY_FILE, rotated);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function persist(summary) {
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_FILE), { recursive: true, mode: 0o700 });
    rotateIfNeeded();
    fs.appendFileSync(TELEMETRY_FILE, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn('[turn-telemetry] unable to persist telemetry:', err?.message || err);
  }
}

export function createTurnTelemetry({ sessionId, turnId, goal = '', resumed = false } = {}) {
  return {
    version: 1,
    sessionId: String(sessionId || ''),
    turnId: String(turnId || ''),
    startedAt: Date.now(),
    resumed: Boolean(resumed),
    goalChars: String(goal || '').length,
    modelCalls: 0,
    modelLatencyMs: 0,
    fallbackAttempts: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolLatencyMs: 0,
    toolRetries: 0,
    tools: {},
    gateReminders: 0,
    maxContextChars: 0,
    tokens: { input: 0, output: 0 },
  };
}

export function recordModelCall(telemetry, { response, latencyMs = 0, contextChars = 0 } = {}) {
  if (!telemetry) return;
  telemetry.modelCalls += 1;
  telemetry.modelLatencyMs += Math.max(0, Math.round(numeric(latencyMs)));
  telemetry.maxContextChars = Math.max(telemetry.maxContextChars, Math.round(numeric(contextChars)));
  telemetry.fallbackAttempts += (response?.attempts || []).filter((attempt) => !attempt?.ok).length;
  const usage = usagePair(response?.usage);
  telemetry.tokens.input += usage.input;
  telemetry.tokens.output += usage.output;
}

export function recordToolCall(telemetry, { call, result, latencyMs = 0 } = {}) {
  if (!telemetry) return;
  const name = String(call?.name || 'unknown').toLowerCase();
  telemetry.toolCalls += 1;
  telemetry.toolLatencyMs += Math.max(0, Math.round(numeric(latencyMs)));
  telemetry.toolRetries += Math.max(0, Math.round(numeric(result?.metadata?.retryCount)));
  if (result?.isError) telemetry.toolErrors += 1;
  const item = telemetry.tools[name] || { calls: 0, errors: 0, latencyMs: 0 };
  item.calls += 1;
  item.latencyMs += Math.max(0, Math.round(numeric(latencyMs)));
  if (result?.isError) item.errors += 1;
  telemetry.tools[name] = item;
}

export function recordCompletionGate(telemetry) {
  if (telemetry) telemetry.gateReminders += 1;
}

function pricingFor(model) {
  const raw = String(process.env.Z_AGENT_MODEL_PRICING_JSON || '').trim();
  if (!raw) return null;
  try {
    const map = JSON.parse(raw);
    const row = map?.[String(model || '')];
    if (!row || typeof row !== 'object') return null;
    const inputPerMillion = numeric(row.inputPerMillion);
    const outputPerMillion = numeric(row.outputPerMillion);
    if (!inputPerMillion && !outputPerMillion) return null;
    return { inputPerMillion, outputPerMillion };
  } catch {
    return null;
  }
}

function estimateCostUsd(telemetry, model) {
  const pricing = pricingFor(model);
  if (!pricing) return null;
  const cost = (numeric(telemetry?.tokens?.input) * pricing.inputPerMillion + numeric(telemetry?.tokens?.output) * pricing.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

export function finalizeTurnTelemetry(telemetry, { outcome = null, strategy = null, model = '', reason = '' } = {}) {
  if (!telemetry) return null;
  const completedAt = Date.now();
  const summary = {
    ...telemetry,
    completedAt,
    durationMs: Math.max(0, completedAt - telemetry.startedAt),
    model: String(model || ''),
    estimatedCostUsd: estimateCostUsd(telemetry, model),
    outcome: String(outcome?.status || ''),
    reason: String(reason || outcome?.reason || '').slice(0, 300),
    changed: Boolean(strategy?.changed),
    changedPathCount: Array.isArray(strategy?.changedPaths) ? strategy.changedPaths.length : 0,
    mutationEpoch: numeric(strategy?.mutationEpoch),
    verificationEpoch: Number.isFinite(Number(strategy?.verificationEpoch)) ? Number(strategy.verificationEpoch) : -1,
    verificationAttempts: numeric(strategy?.verificationAttempts),
    lastVerificationOk: strategy?.lastVerificationOk ?? null,
  };
  persist(summary);
  observeTurnSummary(summary);
  return summary;
}
