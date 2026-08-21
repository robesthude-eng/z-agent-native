import { createHash } from 'node:crypto';
import { classifyBash } from './context.mjs';

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

const EXECUTOR_RETRY_TOOLS = new Set([
  'bash',
  'git',
  'run_tests',
  'diagnostics',
  'browser',
  'apply_patch',
]);

const EXECUTOR_UNAVAILABLE_RE = /executor\.sock|Secure executor is required but unavailable|EXECUTOR_UNAVAILABLE/i;

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

// Счётчики подставлялись в текст с жёстким «раза», поэтому при любом
// значении лимита, кроме 2–4, пользователь видел «5 раза» или «1 раза».
function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0) % 100;
  if (n > 10 && n < 20) return many;
  const tail = n % 10;
  if (tail === 1) return one;
  if (tail >= 2 && tail <= 4) return few;
  return many;
}

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

export function normalizeBashCommand(command) {
  let value = String(command || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  value = value.replace(/\s*\|\s*(?:tail|head)\s+-n?\s*\d+\s*$/i, '');
  value = value.replace(/\s+2>&1\b/g, '');
  value = value.replace(/-newermt\s+'[^']+'/g, '-newermt TS');
  value = value.replace(/-newermt\s+"[^"]+"/g, '-newermt TS');
  value = value.replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b/g, 'TS');
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeToolArguments(name, args) {
  const tool = String(name || '').trim().toLowerCase();
  if (tool !== 'bash' || !args || typeof args !== 'object') return args || {};
  return { ...args, command: normalizeBashCommand(args.command) };
}

function callSignature(call) {
  const name = String(call?.name || '').trim().toLowerCase();
  return `${name}:${stableString(normalizeToolArguments(name, call?.arguments || {}))}`;
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
    callLastSeen: Object.create(null),
    lastMutationAt: -1,
  };
}

const WORKSPACE_MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'ensure_environment']);

function callMutatesWorkspace(call, result) {
  const name = String(call?.name || '').trim().toLowerCase();
  if (WORKSPACE_MUTATING_TOOLS.has(name)) return true;
  if (name === 'bash') return classifyBash(call?.arguments?.command) === 'may_mutate';
  return name === 'task' && Array.isArray(result?.mutatedPaths) && result.mutatedPaths.length > 0;
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
  const index = guard.calls.length;
  // edit/write/mutating bash between two identical checks is progress.
  if (callMutatesWorkspace(call, result) && !result?.isError) guard.lastMutationAt = index;
  if (!guard.callLastSeen) guard.callLastSeen = Object.create(null);
  const lastSeen = Number.isInteger(guard.callLastSeen[signature]) ? guard.callLastSeen[signature] : -1;
  if (lastSeen >= 0 && Number(guard.lastMutationAt) > lastSeen) guard.callCounts[signature] = 0;
  guard.callCounts[signature] = Number(guard.callCounts[signature] || 0) + 1;
  guard.callLastSeen[signature] = index;
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
      message: `Агент ${guard.consecutive} ${plural(guard.consecutive, 'раз', 'раза', 'раз')} подряд повторил одно и то же действие «${name}» без нового результата.`,
    };
  }
  if (guard.callCounts[signature] >= guard.callRepeatLimit) {
    return {
      code: 'repeated_tool_call',
      tool: name,
      repeats: guard.callCounts[signature],
      message: `Агент ${guard.callCounts[signature]} ${plural(guard.callCounts[signature], 'раз', 'раза', 'раз')} повторил одно и то же действие «${name}» в этом ходе.`,
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
export function isExecutorUnavailableError(error) {
  const message = `${error?.code || ''} ${error?.message || String(error || '')}`;
  return error?.code === 'EXECUTOR_UNAVAILABLE' || EXECUTOR_UNAVAILABLE_RE.test(message);
}

export function shouldRetryToolCall(call, error, attempt = 0) {
  const name = String(call?.name || '').trim().toLowerCase();
  const message = `${error?.name || ''} ${error?.code || ''} ${error?.message || String(error || '')}`;
  // A brief executor-socket drop during compose restart used to surface as
  // three identical bash errors and trip the loop guard mid-task.
  if (isExecutorUnavailableError(error) && EXECUTOR_RETRY_TOOLS.has(name) && attempt < 2) return true;
  if (attempt >= 1) return false;
  if (!RETRY_SAFE_TOOLS.has(name)) return false;
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

/**
 * The model re-ran a successful check until the loop guard fired. The artifact
 * is already verified — finish as completed instead of scaring the user with
 * a "stopped to prevent a loop" note.
 */
export function loopStopSatisfiesTask(strategy) {
  return Boolean(strategy) && strategy.needsVerification !== true && strategy.lastVerificationOk === true;
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
