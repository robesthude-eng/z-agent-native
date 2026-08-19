import { createHash } from 'node:crypto';

const RETRY_SAFE_TOOLS = new Set([
  'read',
  'list',
  'glob',
  'grep',
  'repo_map',
  'environment_status',
  'webfetch',
  'websearch',
]);

const TRANSIENT_ERROR_PATTERNS = [
  /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)\b/i,
  /\b(?:timeout|timed out|temporarily unavailable|temporary failure|socket hang up|network error|fetch failed)\b/i,
  /\bHTTP\s+(?:408|425|429|500|502|503|504)\b/i,
  /\b(?:rate limit|too many requests|service unavailable|bad gateway|gateway timeout)\b/i,
];

const OUTCOME_LABELS = {
  completed: 'Готово',
  partial: 'Частично выполнено',
  needs_input: 'Нужны данные',
  failed: 'Ошибка',
  cancelled: 'Остановлено пользователем',
};

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function stableString(value) {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    return String(value ?? '');
  }
}

function digest(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 20);
}

function callSignature(call) {
  const name = String(call?.name || '').trim().toLowerCase();
  return `${name}:${stableString(call?.arguments || {})}`;
}

function observationSignature(call, result) {
  return `${callSignature(call)}:${result?.isError ? 'error' : 'ok'}:${digest(result?.content || '')}`;
}

export function createLoopGuard(options = {}) {
  return {
    consecutiveLimit: Math.max(2, Number(options.consecutiveLimit) || 3),
    recentLimit: Math.max(3, Number(options.recentLimit) || 5),
    recentWindow: Math.max(4, Number(options.recentWindow) || 8),
    callRepeatLimit: Math.max(2, Number(options.callRepeatLimit) || 3),
    cyclePeriodMin: Math.max(3, Number(options.cyclePeriodMin) || 3),
    cyclePeriodMax: Math.max(3, Number(options.cyclePeriodMax) || 6),
    last: null,
    consecutive: 0,
    recent: [],
    calls: [],
    callCounts: Object.create(null),
  };
}

function repeatingCycle(calls, periodMin, periodMax) {
  const seq = Array.isArray(calls) ? calls : [];
  for (let period = periodMax; period >= periodMin; period--) {
    if (seq.length < period * 2) continue;
    const first = seq.slice(-period * 2, -period);
    const second = seq.slice(-period);
    if (first.length === period && first.every((item, index) => item === second[index])) {
      return period;
    }
  }
  return 0;
}

/**
 * Stop no-progress loops:
 * - the same call + same result several times in a row;
 * - the same call (even interleaved) too many times in one turn;
 * - a repeating cycle of 3–6 distinct calls (compile → test → hash → …).
 * Period 2 is ignored so a normal read/edit loop can continue.
 */
export function observeToolLoop(guard, call, result) {
  if (!guard) return null;
  if (!guard.callCounts) guard.callCounts = Object.create(null);
  if (!Array.isArray(guard.calls)) guard.calls = [];

  const name = String(call?.name || 'действие');
  const signature = callSignature(call);
  guard.callCounts[signature] = Number(guard.callCounts[signature] || 0) + 1;
  guard.calls.push(signature);

  const key = observationSignature(call, result);
  if (key === guard.last) guard.consecutive += 1;
  else {
    guard.last = key;
    guard.consecutive = 1;
  }

  guard.recent.push(key);
  if (guard.recent.length > guard.recentWindow) guard.recent.shift();
  const recentCount = guard.recent.reduce((n, item) => n + (item === key ? 1 : 0), 0);

  if (guard.consecutive >= guard.consecutiveLimit) {
    return {
      code: 'repeated_tool_result',
      tool: name,
      repeats: guard.consecutive,
      message: `Агент ${guard.consecutive} раза подряд повторил одно и то же действие «${name}» без нового результата.`,
    };
  }
  if (guard.callCounts[signature] >= guard.callRepeatLimit) {
    return {
      code: 'repeated_tool_call',
      tool: name,
      repeats: guard.callCounts[signature],
      message: `Агент ${guard.callCounts[signature]} раза повторил одно и то же действие «${name}» в этом ходе.`,
    };
  }
  if (recentCount >= guard.recentLimit) {
    return {
      code: 'cyclic_tool_result',
      tool: name,
      repeats: recentCount,
      message: `Агент возвращается к одному и тому же действию «${name}» без заметного прогресса.`,
    };
  }
  const period = repeatingCycle(guard.calls, guard.cyclePeriodMin, guard.cyclePeriodMax);
  if (period) {
    return {
      code: 'cyclic_tool_sequence',
      tool: name,
      repeats: period,
      message: `Агент зациклил набор из ${period} действий и повторяет его без нового результата.`,
    };
  }
  return null;
}

/**
 * Retry only read-only/idempotent operations and only for errors that look
 * transport/transient. Mutating tools, environment provisioning, bash, task and
 * question are deliberately excluded to prevent duplicate side effects.
 */
export function shouldRetryToolCall(call, error, attempt = 0) {
  if (attempt >= 1) return false;
  const name = String(call?.name || '').trim().toLowerCase();
  if (!RETRY_SAFE_TOOLS.has(name)) return false;
  const message = `${error?.name || ''} ${error?.code || ''} ${error?.message || String(error || '')}`;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function retryDelayMs(attempt = 0) {
  return Math.min(1_500, 350 * (2 ** Math.max(0, Number(attempt) || 0)));
}

function planCounts(strategy) {
  const plan = Array.isArray(strategy?.plan) ? strategy.plan : [];
  let completed = 0;
  let remaining = 0;
  for (const item of plan) {
    const status = String(item?.status || 'pending');
    if (status === 'completed') completed += 1;
    else if (status !== 'cancelled') remaining += 1;
  }
  return { completed, remaining };
}

export function classifyTaskOutcome({ strategy, kind = 'completed', reason = '', progress = false } = {}) {
  if (kind === 'cancelled') {
    return { status: 'cancelled', label: OUTCOME_LABELS.cancelled, reason: reason || 'user_cancelled' };
  }
  if (kind === 'needs_input') {
    return { status: 'needs_input', label: OUTCOME_LABELS.needs_input, reason: reason || 'user_input_required' };
  }

  const plan = planCounts(strategy);
  const verificationIncomplete = Boolean(strategy?.needsVerification) || strategy?.lastVerificationOk === false;

  if (kind === 'completed') {
    if (verificationIncomplete || plan.remaining > 0) {
      return {
        status: 'partial',
        label: OUTCOME_LABELS.partial,
        reason: reason || (verificationIncomplete ? 'verification_incomplete' : 'plan_incomplete'),
      };
    }
    return { status: 'completed', label: OUTCOME_LABELS.completed, reason: reason || 'completed' };
  }

  const madeProgress = Boolean(progress) || Boolean(strategy?.changed) || plan.completed > 0;
  return madeProgress
    ? { status: 'partial', label: OUTCOME_LABELS.partial, reason: reason || 'stopped_after_progress' }
    : { status: 'failed', label: OUTCOME_LABELS.failed, reason: reason || 'failed' };
}

export function guardStopError(guardResult) {
  return Object.assign(new Error(guardResult?.message || 'Агент остановлен защитой от зацикливания'), {
    name: 'AgentLoopGuardError',
    code: 'AGENT_LOOP_GUARD',
    guard: guardResult || null,
  });
}

export function stepLimitError(maxSteps) {
  return Object.assign(new Error(`Достигнут безопасный лимит ${maxSteps} шагов автономной работы.`), {
    name: 'AgentStepLimitError',
    code: 'AGENT_STEP_LIMIT',
    maxSteps,
  });
}
