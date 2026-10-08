import { framesFromMessages, systemPrompt, textParts } from '../agent-frames.mjs';
import { memoryPrompt } from '../agent-memory.mjs';
import { instinctsPrompt, observeTurn } from '../instincts.mjs';
import { isInspectionResult, rebuildLoopGuard, rebuildStrategy, recoveryGuidance, waitForRetry } from '../agent-parts.mjs';
import { buildModelPlan, callModelAutopilot, modelKey, promoteModelPlan, taskStepBudget } from '../autopilot.mjs';
import { effectiveToolOptions, filterChatTools, normalizeChatToolOptions } from '../chat-tool-options.mjs';
import { isClustered, releaseTurnLock, renewTurnLock } from '../cluster.mjs';
import { MAX_AGENT_STEPS_CEILING } from '../config.mjs';
import {
  compactFrames,
  completionGate,
  contextWeight,
  createTurnStrategy,
  MAX_COMPLETION_GATE_REMINDERS,
  observeTool,
  shouldEnforceCompletionGate,
  strategyGuidance,
} from '../context.mjs';
import { checkpointDurableJob, markDurableJobFinalizing } from '../durable-jobs.mjs';
import { emit } from '../events.mjs';
import { executorNetworkless, executorRequired, probeExecutor } from '../executor-client.mjs';
import { partId } from '../ids.mjs';
import { mediaChannelsPrompt } from '../media-generation.mjs';
import { getProjectContext, rememberProjectTurn } from '../project-context.mjs';
import { isTransientProviderError } from '../providers/transport.mjs';
import { isModelUnavailableError, isNetworkTransportError, publicProviderErrorMessage } from '../providers.mjs';
import { splitReasoningFromContent } from '../reasoning-parser.mjs';
import { chatSkillSettings, setChatSkillSettings, skillsPrompt } from '../skills/library.mjs';
import { getTurn, listMessages, putMessage, releaseTurnCapacity, renewTurnCapacity, setTurn, workspaceFor } from '../store.mjs';
import { availableToolDefinitions } from '../tools.mjs';
import { assertTurnTransition } from '../turn-lifecycle.mjs';
import { createTurnTelemetry, finalizeTurnTelemetry, recordCompletionGate, recordModelCall, recordToolCall } from '../turn-telemetry.mjs';
import {
  classifyTaskOutcome,
  createLoopGuard,
  guardStopError,
  loopStopSatisfiesTask,
  observeToolLoop,
  stepLimitError,
} from '../turn-trust.mjs';
import { agentFeatures, userSettingsPrompt } from '../user-settings-prompt.mjs';
import { runtimeCapabilityPrompt } from '../workspace-policy.mjs';
import { framesWithDossier } from './dossier.mjs';
import {
  demoteDraftTextToReasoning,
  emitPart,
  emitText,
  persistAssistant,
  promoteReasoningToText,
  settleOpenToolParts,
} from './message-parts.mjs';
import { resumePendingQuestion } from './questions.mjs';
import { interruptedToolParts } from './recovery.mjs';
import { formatIssues, reviewTurn, shouldReview } from './reviewer.mjs';
import { activeTurns, idleWaiters, TURN_CAPACITY_TTL_MS } from './state.mjs';

// Сколько раз подряд шаг модели повторяется после временного сбоя провайдера
// (сеть, 429, 5xx, таймаут стрима). Счётчик сбрасывается после каждого
// успешного вызова: раньше он копился на весь ход, и третий за длинную задачу
// сетевой «моргок» убивал её целиком.
const MAX_MODEL_STEP_RETRIES = 4;
const MODEL_STEP_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000];
// Сколько раз продолжать ответ, оборванный обрывом стрима или лимитом токенов.
const MAX_CONTINUATIONS = 3;
// Сколько предупреждений получает модель от защиты от зацикливания, прежде
// чем ход будет остановлен. Первое срабатывание — подсказка сменить подход,
// а не мгновенная остановка посреди задачи.
const MAX_LOOP_WARNINGS = 1;
const LENGTH_FINISH_RE = /^(length|max_tokens|max_output_tokens|MAX_TOKENS)$/i;

function resetLoopGuardCounters(guard) {
  if (!guard) return;
  guard.last = null;
  guard.consecutive = 0;
  guard.recent = [];
  guard.calls = [];
  guard.callCounts = Object.create(null);
  guard.callLastSeen = Object.create(null);
  guard.lastMutationAt = -1;
}

// Провайдер отказал из-за длины запроса («Prompt exceeds max length»,
// context_length_exceeded и т.п.). Это не повод заканчивать ход: история
// сжимается сильнее и шаг повторяется.
const CONTEXT_OVERFLOW_RE =
  /prompt (?:exceeds|is too long)|exceeds (?:the )?max(?:imum)? (?:length|context|tokens?)|context[_ ](?:length|window)(?:[_ ]exceeded)?|maximum context length|too many (?:input )?tokens|input (?:is )?too long|request too large|reduce the length/i;
const MIN_CONTEXT_BUDGET = 24_000;
const MAX_OVERFLOW_RETRIES = 4;
// Запоминаем сработавший бюджет для модели, чтобы следующие ходы не
// упирались в тот же лимит заново.
const learnedContextBudget = new Map();

export function isContextOverflowError(err) {
  const status = Number(err?.statusCode || err?.status) || 0;
  const text = `${err?.message || ''} ${err?.body ? JSON.stringify(err.body) : ''}`;
  if (status === 413) return true;
  return CONTEXT_OVERFLOW_RE.test(text);
}

function overflowError(err) {
  if (isContextOverflowError(err)) return err;
  for (const attempt of [...(err?.attempts || []), ...(err?.autopilotAttempts || [])]) {
    if (attempt?.error && isContextOverflowError({ message: String(attempt.error), statusCode: attempt.status })) return err;
  }
  return null;
}

function retryableModelError(err, signal) {
  if (err?.name === 'AbortError' || signal?.aborted) return false;
  if (isModelUnavailableError(err)) return false;
  return isNetworkTransportError(err) || isTransientProviderError(err, signal);
}

function remainingPlanItems(strategy) {
  const plan = Array.isArray(strategy?.plan) ? strategy.plan : [];
  return plan.filter((item) => {
    const status = String(item?.status || 'pending');
    return status !== 'completed' && status !== 'cancelled';
  });
}

// A reply with no tool call whose last sentence only announces the next step
// ("Let me close the browser now.", "Сейчас запущу тесты.") is not a final
// answer: the model stopped mid-task. Detect that narrow pattern.
const DANGLING_INTENT_RE =
  /(?:^|[.!?\n]\s*)(?:let me(?! know)|let's|i'll|i will|i'm going to|now i(?:'ll| will)|next,? i|сейчас|теперь (?:я )?(?:запущу|проверю|открою|закрою|сделаю|выполню|попробую|исправлю)|далее|давай(?:те)?|пробую|попробую|запускаю|открываю|проверяю)(?=[\s,.:!…']|$)[^.!?\n]{0,160}[.!…:]?\s*$/iu;
const MAX_DANGLING_INTENT_NUDGES = 2;

export function expectsUserReply(text) {
  const tail =
    String(text || '')
      .trim()
      .split(/\n\s*\n/)
      .at(-1) || '';
  // A request for the user's next decision is a stopping point, even when
  // followed by "and I will start". Optional offers are not blocking requests.
  if (/^(?:если (?:хотите|нужно|понадобится)|if you (?:want|need)|let me know if)/iu.test(tail)) return false;
  // Ответ, который заканчивается вопросом к пользователю («Какой вариант
  // выбрать?», «Would you like me to…?»), — тоже точка остановки.
  if (/\?\s*[*_)»"']*\s*$/u.test(tail) && !/```\s*$/.test(tail)) return true;
  return /^(?:\*{0,2})(?:скажите|скажи|пришлите|пришли|уточните|уточни|выберите|выбери|подтвердите|подтверди|укажите|укажи|сообщите|сообщи|что (?:делаем|сделать) дальше|please (?:provide|send|choose|confirm|specify)|(?:provide|send|choose|confirm|specify) (?:the|your|a)|which (?:option|project)|what (?:would you like|should we))/iu.test(
    tail,
  );
}

export function endsWithDanglingIntent(text) {
  const tail = String(text || '')
    .trim()
    .slice(-400);
  if (!tail || expectsUserReply(text)) return false;
  return DANGLING_INTENT_RE.test(tail);
}

function planContinuationGate(strategy) {
  // A stale todo after a read-only investigation must not restart work after
  // the model's final report. Unfinished items still produce a partial outcome.
  if (!strategy?.changed) return null;
  const remaining = remainingPlanItems(strategy);
  if (!remaining.length) return null;
  return [
    '[Runtime plan gate]',
    `Your todo plan still has ${remaining.length} unfinished item(s):`,
    ...remaining.slice(0, 10).map((item) => `- [${item.status}] ${item.content}`),
    'Do not stop yet. Continue working on the remaining items with tools. If an item is already done or no longer needed, update the plan with todowrite (mark it completed or cancelled) and then give the final answer. If you are blocked and need the user, use the question tool.',
  ].join('\n');
}

import { liveTextSink } from './streaming.mjs';
import { planBatches, runBatch } from './parallel.mjs';
import { assistantHasProgress, executeCall, strategyInfo } from './tool-cycle.mjs';
import { createToolCallSink } from './tool-stream.mjs';

export function notifyTurnIdle(sessionId) {
  if (isClustered()) {
    try {
      releaseTurnLock(sessionId);
    } catch {}
  }
  try {
    releaseTurnCapacity(sessionId);
  } catch {}
  const waiters = idleWaiters.get(sessionId);
  if (!waiters) return;
  idleWaiters.delete(sessionId);
  for (const resolve of waiters) {
    try {
      resolve();
    } catch {}
  }
}

export function updateTurn(sessionId, state, transitionOptions = {}) {
  const now = Date.now();
  const current = activeTurns.get(sessionId);
  const projection = {
    turnId: current?.turnId || state.turnId || `turn_${Date.now()}`,
    lifecycle: state.lifecycle,
    verdict: state.verdict ?? null,
    reason: state.reason ?? null,
    since: state.since ?? now,
  };
  assertTurnTransition(getTurn(sessionId), projection, transitionOptions);
  setTurn(sessionId, projection);
  emit(sessionId, 'session.status', {
    status:
      projection.lifecycle === 'waiting_user_input'
        ? 'busy'
        : projection.lifecycle === 'failed'
          ? 'error'
          : projection.lifecycle === 'completed' || projection.lifecycle === 'cancelled'
            ? 'idle'
            : 'busy',
    lifecycle: projection.lifecycle,
    turnID: projection.turnId,
    waiting: projection.lifecycle === 'waiting_user_input' || projection.lifecycle === 'waiting_permission',
  });
  return projection;
}

export async function finalizeAssistant({
  sessionId,
  assistant,
  strategy,
  usage,
  outcome,
  telemetry = null,
  finish = 'stop',
  note = '',
  error = null,
  publicError = '',
  lifecycle = 'completed',
  verdict = 'completed',
  reason = 'model_final',
}) {
  if (note) await emitText(assistant, note, 'text', { putMessage, emit });
  assistant.time.completed = Date.now();
  assistant.info.finish = finish;
  assistant.info.tokens = usage
    ? {
        input: usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokenCount,
        output: usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.candidatesTokenCount,
      }
    : undefined;
  assistant.info.strategy = strategyInfo(strategy);
  assistant.info.outcome = outcome;
  assistant.info.telemetry = finalizeTurnTelemetry(telemetry, { outcome, strategy, model: assistant.info.model || '', reason });
  assistant.info.time = { ...(assistant.info.time || {}), completed: assistant.time.completed };
  if (error) assistant.info.error = turnErrorInfo(error, publicError);
  rememberProjectTurn(sessionId, {
    goal: strategy?.goal || '',
    outcome: outcome?.status || verdict,
    model: assistant.info.model || '',
    changed: Boolean(strategy?.changed),
    summary: textParts(assistant).slice(-2_000),
  });
  settleOpenToolParts(assistant, { putMessage, emit });
  persistAssistant(assistant, { putMessage, emit });
  if (assistant.info.telemetry) emit(sessionId, 'turn.telemetry', { telemetry: assistant.info.telemetry });
  try {
    markDurableJobFinalizing(sessionId, { status: outcome?.status || verdict, reason, completedAt: assistant.time.completed });
  } catch {}
  updateTurn(sessionId, { lifecycle, verdict, since: Date.now(), reason });
  emit(sessionId, 'session.idle', {});
  return assistant;
}

/**
 * What the error banner shows: the user-facing explanation first, the raw
 * provider text and HTTP status only under «Детали».
 */
export function turnErrorInfo(error, publicError = '') {
  const raw = String(error?.message || error || '').trim();
  const message = String(publicError || '').trim() || raw || 'Ошибка';
  const info = { message, name: error?.name || 'Error' };
  if (raw && raw !== message) info.detail = raw.slice(0, 2_000);
  const status = Number(error?.statusCode);
  if (Number.isInteger(status) && status > 0) info.statusCode = status;
  return info;
}

/** A structured stop report has substance beyond the error itself. */
export function hasStructuredSummary(strategy) {
  return (
    (Array.isArray(strategy?.changedPaths) && strategy.changedPaths.length > 0) ||
    (Array.isArray(strategy?.plan) && strategy.plan.length > 0) ||
    Boolean(strategy?.lastVerificationEvidence)
  );
}

export function safeAttemptInfo(attempt) {
  return {
    model: modelKey(attempt?.model),
    ok: Boolean(attempt?.ok),
    latencyMs: Math.max(0, Math.round(Number(attempt?.latencyMs) || 0)),
  };
}

export function checkpointState(sessionId, runtime, strategy, fields = {}) {
  if (isClustered()) {
    try {
      renewTurnLock(sessionId);
    } catch {}
  }
  try {
    checkpointDurableJob(
      sessionId,
      {
        phase: fields.phase || 'running',
        toolOptions: runtime.toolOptions,
        stepsUsed: Number(fields.stepsUsed ?? runtime.stepsUsed ?? 0),
        gateReminders: Number(fields.gateReminders ?? runtime.gateReminders ?? 0),
        intentNudges: Number(fields.intentNudges ?? runtime.intentNudges ?? 0),
        reviewsDone: Number(fields.reviewsDone ?? runtime.reviewsDone ?? 0),
        visualNudges: Number(fields.visualNudges ?? runtime.visualNudges ?? 0),
        lastUsage: fields.lastUsage ?? runtime.lastUsage ?? null,
        strategy: strategy
          ? {
              goal: strategy.goal,
              plan: strategy.plan,
              changed: strategy.changed,
              needsVerification: strategy.needsVerification,
              verificationAttempts: strategy.verificationAttempts,
              lastVerificationOk: strategy.lastVerificationOk,
              toolErrors: strategy.toolErrors,
            }
          : null,
        ambiguousCalls: [...(runtime.recovery?.ambiguousSignatures || [])],
        recoveryInspected: Boolean(runtime.recovery?.inspected),
      },
      { modelPlan: runtime.modelPlan },
    );
  } catch {}
}

export function synthesizeTurnSummary({ strategy, outcome, note = '', error = null }) {
  const isFailed = outcome?.status === 'failed' || error != null;
  const isPartial = outcome?.status === 'partial';
  const isCancelled = outcome?.status === 'cancelled';
  const needsInput = outcome?.status === 'needs_input';
  const changed = Array.isArray(strategy?.changedPaths) && strategy.changedPaths.length > 0;
  const hasPlan = Array.isArray(strategy?.plan) && strategy.plan.length > 0;
  const hasEvidence = Boolean(strategy?.lastVerificationEvidence);

  if (!changed && !hasPlan && !hasEvidence) {
    if (isFailed) {
      return note || error?.message || 'Не удалось завершить операцию из-за ошибки.';
    }
    if (isCancelled) return note || 'Ход остановлен пользователем. Выполнение задачи не подтверждено.';
    if (needsInput) return note || 'Для продолжения нужны данные пользователя.';
    if (isPartial) return note || 'Задача выполнена не полностью. Подтверждённых результатов проверки нет.';
    return note || 'Модель завершила ответ без итогового отчёта. Результаты выполнения и проверок не подтверждены.';
  }

  const lines = [];
  if (isCancelled || needsInput) {
    lines.push(isCancelled ? '### Ход остановлен пользователем' : '### Нужны данные пользователя');
    if (note) lines.push(note);
    lines.push('');
  } else if (isFailed) {
    lines.push('### ⚠️ Задача остановлена');
    if (note) lines.push(note);
    if (error?.message) lines.push(`**Причина:** ${error.message}`);
    lines.push('');
  } else if (isPartial) {
    lines.push('### ⏳ Задача выполнена частично');
    if (note) lines.push(note);
    lines.push('');
  } else {
    lines.push('### 📋 Отчет о выполнении задачи\n');
  }

  if (changed) {
    lines.push('**1. Измененные файлы и компоненты:**');
    for (const p of strategy.changedPaths.slice(-15)) {
      lines.push(`- \`${p}\``);
    }
    lines.push('');
  }

  if (hasPlan) {
    lines.push('**2. Состояние плана:**');
    for (const item of strategy.plan.slice(0, 10)) {
      const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '⏳' : '○';
      lines.push(`- ${mark} ${item.content}`);
    }
    lines.push('');
  }

  if (hasEvidence) {
    const v = strategy.lastVerificationEvidence;
    lines.push(
      v.executable === false
        ? '**3. Верификация:** Файлы прочитаны после изменений. Запуск тестов и исполняемых проверок недоступен; их результат не подтверждён.'
        : `**3. Верификация:** Проверка выполнена через инструмент \`${v.tool}\` (${v.ok ? 'успешно' : 'с замечаниями'}).`,
    );
    if (v.detail) lines.push(`> \`${v.detail.slice(0, 200)}\``);
    lines.push('');
  } else if (changed && strategy?.gitEvidence) {
    // Коммит или чистый git status — это сохранение, а не проверка работы.
    lines.push(
      `**3. Верификация:** не выполнялась. Git: ${({ commit: 'изменения закоммичены', create_branch: 'создана ветка' })[strategy.gitEvidence.action] || 'рабочее дерево чистое'}, но это не подтверждает, что изменения работают.`,
    );
    lines.push('');
  }

  if (isFailed || isPartial) {
    lines.push('**4. Рекомендация:**');
    lines.push('- Проверьте детали ошибки и повторите выполнение после устранения сбоя.');
  }

  const text = lines.join('\n').trim();
  return text || 'Подтверждённых результатов выполнения нет.';
}

const UI_FILE_RE = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$/i;

export function uiFilesChanged(strategy) {
  const paths = Array.isArray(strategy?.changedPaths) ? strategy.changedPaths : [];
  return paths.filter((p) => UI_FILE_RE.test(String(p || '')) && !/(^|\/)(\.screenshots|node_modules|dist|build)\//.test(String(p)));
}

/** Ревью показывается в чате отдельной карточкой «review» и не идёт в историю модели. */
async function runReview({ assistant, runtime, goal, strategy, workspace, draft, signal }) {
  const part = {
    id: partId(),
    type: 'tool',
    tool: 'review',
    callID: `review_${partId()}`,
    state: {
      status: 'running',
      input: { files: (strategy.changedPaths || []).slice(-20) },
      title: 'Ревью изменений перед ответом',
      metadata: { runtimeReview: true },
      time: { start: Date.now() },
    },
  };
  emitPart(assistant, part, { putMessage, emit });
  let review = null;
  let error = null;
  try {
    review = await reviewTurn({ ownerId: runtime.ownerId, modelPlan: runtime.modelPlan, goal, strategy, workspace, draft, signal });
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) throw err;
    error = err;
  }
  const output = review
    ? review.verdict === 'fix'
      ? `Найдены проблемы (${review.issues.length}), агент исправляет:\n${formatIssues(review)}`
      : `Замечаний нет.${review.summary ? ` ${review.summary}` : ''}`
    : `Ревью не выполнено: ${error ? publicProviderErrorMessage(error) : 'ревьюер не вернул разбор'}`;
  part.state = {
    ...part.state,
    status: 'completed',
    title: review?.verdict === 'fix' ? `Ревью: найдено проблем — ${review.issues.length}` : 'Ревью: замечаний нет',
    output,
    metadata: { ...part.state.metadata, review: review ? { verdict: review.verdict, issues: review.issues.length } : null },
    time: { ...part.state.time, end: Date.now() },
  };
  emitPart(assistant, part, { putMessage, emit });
  return review;
}

export async function executeTurnLifecycle({
  sessionId,
  ownerId,
  assistant,
  requestedModel,
  system,
  toolOptions: requestedToolOptions = null,
  goal,
  controller,
  resume = false,
  job = null,
}) {
  const toolOptions = effectiveToolOptions(
    normalizeChatToolOptions(resume ? job?.checkpoint?.toolOptions : requestedToolOptions),
    availableToolDefinitions(),
  );
  const turnTools = () => filterChatTools(availableToolDefinitions(), toolOptions);
  // Описание среды для модели опирается на ответ самого executor о его сети.
  if (executorRequired() && executorNetworkless() === null) await probeExecutor().catch(() => null);
  const mediaPrompt = turnTools().some((t) => t.name === 'generate_image' || t.name === 'generate_speech')
    ? mediaChannelsPrompt(ownerId)
    : '';
  const features = agentFeatures(ownerId);
  const settings = chatSkillSettings(ownerId, sessionId);
  if (settings.mode !== 'off') {
    // Explicit $skill-name /skill-name mentions unlock manual-only skills.
    const names = [...String(goal || '').matchAll(/(?:^|\s)[/$]([a-z0-9]+(?:-[a-z0-9]+)*)\b/g)].map((m) => m[1]);
    if (names.length) {
      const library = (await import('../store/memory.mjs')).listSkills(ownerId);
      const selected = [...new Set([...settings.selected, ...names.filter((n) => library.some((s) => s.name === n && s.enabled))])].slice(
        0,
        8,
      );
      setChatSkillSettings(ownerId, sessionId, { selected });
    }
  }
  const ownerPrompt = [
    userSettingsPrompt(ownerId),
    features.memory ? memoryPrompt(ownerId, sessionId, { includeSkills: false }) : '',
    features.instincts ? instinctsPrompt(ownerId, sessionId) : '',
    skillsPrompt(ownerId, sessionId, workspaceFor(sessionId)),
  ]
    .filter(Boolean)
    .join('\n\n');
  const strategy = resume ? rebuildStrategy(goal, assistant) : createTurnStrategy(goal);
  let lastUsage = job?.checkpoint?.lastUsage || null;
  let lockPulse = null;
  let capacityPulse = null;
  let runtime = null;

  try {
    if (resume) await resumePendingQuestion(sessionId, assistant, controller.signal, updateTurn);
    const interrupted = resume ? interruptedToolParts(assistant) : [];
    const persistedAmbiguous = Array.isArray(job?.checkpoint?.ambiguousCalls) ? job.checkpoint.ambiguousCalls : [];
    const ambiguousSignatures = new Set([...persistedAmbiguous, ...interrupted]);
    runtime = {
      ownerId,
      toolOptions,
      modelPlan: job?.modelPlan?.candidates?.length ? job.modelPlan : await buildModelPlan(ownerId, requestedModel, goal),
      projectContext: await getProjectContext(sessionId, workspaceFor(sessionId), controller.signal),
      stepsUsed: Math.max(0, Number(job?.checkpoint?.stepsUsed) || 0),
      gateReminders: Math.max(0, Number(job?.checkpoint?.gateReminders) || 0),
      intentNudges: Math.max(0, Number(job?.checkpoint?.intentNudges) || 0),
      lastUsage,
      recovery: {
        resumed: resume,
        ambiguousSignatures,
        inspected: Boolean(job?.checkpoint?.recoveryInspected) || ambiguousSignatures.size === 0,
      },
      telemetry: createTurnTelemetry({ sessionId, turnId: job?.turnId || getTurn(sessionId)?.turnId || '', goal, resumed: resume }),
    };
    const initialModel = runtime.modelPlan.candidates[0];
    const modelLocked = Boolean(runtime.modelPlan.locked);
    assistant.info.model = assistant.info.model || modelKey(initialModel);
    assistant.info.autopilot = {
      ...(assistant.info.autopilot || {}),
      enabled: !modelLocked,
      mode: modelLocked ? 'locked' : 'auto',
      requested: modelKey(initialModel),
      budget: Number(job?.stepBudget) || taskStepBudget(goal),
      candidates: runtime.modelPlan.candidates.map(modelKey),
      selected: assistant.info.model || modelKey(initialModel),
      fallbackCount: Number(assistant.info.autopilot?.fallbackCount || 0),
      ...(resume ? { resumed: true, resumeCount: Number(job?.resumeCount || 0) } : {}),
    };
    checkpointState(sessionId, runtime, strategy, { phase: resume ? 'resumed' : 'prepared' });
    if (isClustered()) {
      lockPulse = setInterval(() => {
        try {
          renewTurnLock(sessionId);
        } catch {}
      }, 5_000);
      lockPulse.unref?.();
    }
    capacityPulse = setInterval(
      () => {
        try {
          renewTurnCapacity(sessionId, { ttlMs: TURN_CAPACITY_TTL_MS });
        } catch {}
      },
      Math.min(30_000, Math.max(10_000, Math.floor(TURN_CAPACITY_TTL_MS / 3))),
    );
    capacityPulse.unref?.();

    const workspace = workspaceFor(sessionId);
    const messages = listMessages(sessionId);
    const history = resume ? messages : messages.filter((m) => m.id !== assistant.id);
    const frames = await framesWithDossier({
      sessionId,
      ownerId,
      modelPlan: runtime.modelPlan,
      history,
      framesFor: (msgs) => framesFromMessages(msgs, workspace),
      signal: controller.signal,
      enabled: features.dossier,
    });
    runtime.reviewsDone = Math.max(0, Number(job?.checkpoint?.reviewsDone) || 0);
    runtime.visualNudges = Math.max(0, Number(job?.checkpoint?.visualNudges) || 0);
    const maxSteps = Math.max(1, Math.min(MAX_AGENT_STEPS_CEILING, Number(job?.stepBudget) || taskStepBudget(goal)));
    const rebuilt = resume ? rebuildLoopGuard(assistant) : { guard: createLoopGuard(), stop: null };
    const loopGuard = rebuilt.guard;
    let guardedStop = rebuilt.stop ? guardStopError(rebuilt.stop) : null;
    let modelStepRetries = 0;
    let continuations = 0;
    let loopWarnings = 0;

    for (let step = runtime.stepsUsed; step < maxSteps && !guardedStop; step++) {
      if (controller.signal.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
      runtime.stepsUsed = step;
      checkpointState(sessionId, runtime, strategy, { phase: 'before_model', stepsUsed: step });
      const live = liveTextSink(assistant);
      const toolSink = createToolCallSink(assistant, { emit, persist: (a) => putMessage(a) });
      const budgetKey = (runtime.modelPlan?.candidates || []).map(modelKey).join('|');
      if (!runtime.contextBudget && learnedContextBudget.has(budgetKey)) runtime.contextBudget = learnedContextBudget.get(budgetKey);
      const providerFrames = compactFrames(frames, runtime.contextBudget ? { maxChars: runtime.contextBudget } : {});
      const modelStartedAt = Date.now();
      let response;
      try {
        response = await callModelAutopilot(ownerId, runtime.modelPlan, {
          system: [
            systemPrompt({
              toolNames: turnTools().map((t) => t.name),
              goal,
              projectContext: runtime.projectContext,
              bashFirst: toolOptions.bashFirst,
            }),
            runtimeCapabilityPrompt(),
            mediaPrompt,
            ownerPrompt,
            runtime.projectContext,
            system || '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          // Меняется почти на каждом шаге (план, статус проверки) — отдельно, чтобы не ломать кэш префикса.
          systemTail: [recoveryGuidance(runtime.recovery), strategyGuidance(strategy)].filter(Boolean).join('\n\n'),
          frames: providerFrames,
          tools: turnTools(),
          signal: controller.signal,
          onTextDelta: (delta, type = null) => live.push(delta, type),
          onToolCall: (call) => toolSink.onToolCall(call),
          onToolCallsReset: () => toolSink.discard(),
        });
      } catch (err) {
        toolSink.discard();
        if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
        if (overflowError(err) && (runtime.overflowRetries || 0) < MAX_OVERFLOW_RETRIES) {
          const sent = contextWeight(providerFrames);
          const next = Math.max(MIN_CONTEXT_BUDGET, Math.floor(Math.min(sent, runtime.contextBudget || sent) * 0.55));
          if (next < (runtime.contextBudget || Number.POSITIVE_INFINITY) || sent > next) {
            runtime.overflowRetries = (runtime.overflowRetries || 0) + 1;
            runtime.contextBudget = next;
            learnedContextBudget.set(budgetKey, next);
            live.finish();
            step -= 1;
            continue;
          }
        }
        if (retryableModelError(err, controller.signal) && modelStepRetries < MAX_MODEL_STEP_RETRIES) {
          const hinted = Number(err?.retryAfterMs);
          const base = MODEL_STEP_RETRY_DELAYS_MS[Math.min(modelStepRetries, MODEL_STEP_RETRY_DELAYS_MS.length - 1)];
          modelStepRetries += 1;
          live.finish();
          await waitForRetry(Number.isFinite(hinted) && hinted > 0 ? Math.min(60_000, Math.max(base, hinted)) : base, controller.signal);
          step -= 1;
          continue;
        }
        throw err;
      }
      modelStepRetries = 0;
      recordModelCall(runtime.telemetry, {
        response,
        latencyMs: Date.now() - modelStartedAt,
        contextChars: JSON.stringify(providerFrames).length,
      });
      const streamed = live.finish();
      runtime.modelPlan = promoteModelPlan(runtime.modelPlan, response.model);
      assistant.info.model = modelKey(response.model);
      const failedAttempts = (response.attempts || []).filter((attempt) => !attempt.ok).length;
      assistant.info.autopilot = {
        ...assistant.info.autopilot,
        candidates: runtime.modelPlan.candidates.map(modelKey),
        selected: modelKey(response.model),
        fallbackCount: Number(assistant.info.autopilot?.fallbackCount || 0) + failedAttempts,
        lastAttempts: (response.attempts || []).map(safeAttemptInfo),
      };
      lastUsage = response.usage || lastUsage;
      runtime.lastUsage = lastUsage;
      runtime.stepsUsed = step + 1;
      checkpointState(sessionId, runtime, strategy, { phase: 'after_model', stepsUsed: step + 1, lastUsage });
      const calls = response.toolCalls || [];
      if (calls.length === 0) toolSink.discard();
      // Ответ оборван (обрыв стрима или лимит токенов) и не содержит вызовов
      // инструментов: это не финал. Сохраняем полученную часть в контексте и
      // просим модель продолжить с места обрыва, а не закрываем ход.
      const cutOff = Boolean(response.interrupted) || LENGTH_FINISH_RE.test(String(response.finish || ''));
      if (calls.length === 0 && cutOff && continuations < MAX_CONTINUATIONS) {
        continuations += 1;
        frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
        frames.push({
          role: 'user',
          content: response.interrupted
            ? '[Runtime] Your previous response was cut off by a dropped provider connection. Continue the task exactly from where you stopped. Do not repeat text you already wrote and do not announce that you are continuing; call tools if the work is not finished.'
            : '[Runtime] Your previous response hit the output token limit and was cut off. Continue exactly from where you stopped without repeating earlier text and without announcing that you are continuing. Prefer smaller steps (for example, several smaller edits instead of one huge write).',
        });
        checkpointState(sessionId, runtime, strategy, { phase: 'continuation' });
        continue;
      }
      if (calls.length > 0 || !cutOff) continuations = 0;
      if (calls.length === 0) {
        const waitingForUser = expectsUserReply(response.text);
        const planGate =
          !waitingForUser && !completionGate(strategy) && runtime.gateReminders < MAX_COMPLETION_GATE_REMINDERS
            ? planContinuationGate(strategy)
            : null;
        if (planGate) {
          runtime.gateReminders += 1;
          recordCompletionGate(runtime.telemetry);
          frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
          frames.push({ role: 'user', content: `${planGate}\nReminder attempt: ${runtime.gateReminders}.` });
          checkpointState(sessionId, runtime, strategy, { phase: 'completion_gate', gateReminders: runtime.gateReminders });
          continue;
        }
        if (!waitingForUser && shouldEnforceCompletionGate(strategy, runtime.gateReminders)) {
          const gate = completionGate(strategy);
          runtime.gateReminders += 1;
          recordCompletionGate(runtime.telemetry);
          frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
          frames.push({ role: 'user', content: `${gate}\nReminder attempt: ${runtime.gateReminders}.` });
          checkpointState(sessionId, runtime, strategy, { phase: 'completion_gate', gateReminders: runtime.gateReminders });
          continue;
        }
        const reasoningOnly = Boolean(response.textFromReasoning) && streamed.reasoning;
        if (!reasoningOnly && runtime.intentNudges < MAX_DANGLING_INTENT_NUDGES && endsWithDanglingIntent(response.text)) {
          runtime.intentNudges += 1;
          recordCompletionGate(runtime.telemetry);
          frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
          frames.push({
            role: 'user',
            content:
              "[Runtime] Your last message announced a next step but contained no tool call and no final answer, so the turn would end here. If work remains, perform that step now with tools. If the task is complete, write the final answer for the user (in the user's language) with the actual results. Do not claim actions you did not perform.",
          });
          checkpointState(sessionId, runtime, strategy, { phase: 'intent_gate', intentNudges: runtime.intentNudges });
          continue;
        }
        if (
          !waitingForUser &&
          !reasoningOnly &&
          runtime.visualNudges < 1 &&
          features.visualCheck &&
          uiFilesChanged(strategy).length > 0 &&
          strategy.visualEpoch !== strategy.mutationEpoch &&
          turnTools().some((t) => t.name === 'visual_check')
        ) {
          runtime.visualNudges += 1;
          frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
          frames.push({
            role: 'user',
            content: `[Runtime visual check] You changed UI files (${uiFilesChanged(strategy).slice(-6).join(', ')}) but have not looked at the rendered result since the last change. Call visual_check on the affected page (workspace HTML path or the running dev-server URL), examine both screenshots, fix anything that looks broken, then give the final answer. If the UI cannot be rendered in a browser at all, say so briefly in the final answer instead.`,
          });
          checkpointState(sessionId, runtime, strategy, { phase: 'visual_gate', visualNudges: runtime.visualNudges });
          continue;
        }
        if (!reasoningOnly && shouldReview(strategy, { enabled: features.review, reviewsDone: runtime.reviewsDone, waitingForUser })) {
          runtime.reviewsDone += 1;
          const review = await runReview({
            assistant,
            runtime,
            goal,
            strategy,
            workspace,
            draft: response.text,
            signal: controller.signal,
          });
          checkpointState(sessionId, runtime, strategy, { phase: 'review', reviewsDone: runtime.reviewsDone });
          if (review?.verdict === 'fix') {
            demoteDraftTextToReasoning(assistant, streamed.parts, { putMessage, emit });
            frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
            frames.push({
              role: 'user',
              content: `[Runtime review] Before you finish, an independent reviewer checked the changed files against the goal and found problems:\n${formatIssues(review)}\n\nFix the real problems now and re-run the relevant verification. If an item is a false positive, do not change the code for it — just mention it briefly in the final answer. Then write the final answer (it must reflect the fixed state, not the draft).`,
            });
            continue;
          }
        }
        let finalText = reasoningOnly ? '' : String(response.text || '').trim();
        if (!finalText && step > 0) {
          try {
            frames.push({ role: 'assistant', content: '', toolCalls: [] });
            frames.push({
              role: 'user',
              content:
                '[System Instruction] All tool operations are done. Please write your final structured summary report for the user in Russian (detailing: 1. What was done/changed with file paths; 2. Verification results; 3. Final status). Do not call any tools.',
            });
            const summaryRes = await callModelAutopilot(ownerId, runtime.modelPlan, {
              system: [
                systemPrompt({ toolNames: turnTools().map((t) => t.name), goal, projectContext: runtime.projectContext }),
                runtimeCapabilityPrompt(),
                mediaPrompt,
                ownerPrompt,
                runtime.projectContext,
                system || '',
              ]
                .filter(Boolean)
                .join('\n\n'),
              frames: compactFrames(frames),
              tools: [],
              signal: controller.signal,
            });
            finalText = String(summaryRes.text || '').trim();
          } catch (err) {
            if (!controller.signal.aborted)
              console.warn(`[turn] ${sessionId}: final summary request failed: ${String(err?.message || err).slice(0, 300)}`);
          }
        }
        let promotedReasoning = false;
        if (!finalText && reasoningOnly) {
          finalText = String(response.text || '').trim();
          // Ответ целиком пришёл в канале рассуждений и уже стоит на экране
          // карточкой «мыслей». Раньше его печатали ещё раз текстом — и один
          // и тот же итог показывался дважды. Теперь карточка сама становится
          // ответом.
          promotedReasoning = promoteReasoningToText(assistant, streamed.parts, finalText, { putMessage, emit });
        }
        if (!finalText) {
          const outcome = classifyTaskOutcome({ strategy, kind: 'completed' });
          finalText = synthesizeTurnSummary({ strategy, outcome });
        }
        if (!streamed.text && !promotedReasoning) {
          const separated = splitReasoningFromContent(finalText);
          if (separated.reasoning && !streamed.reasoning) {
            await emitText(assistant, separated.reasoning, 'reasoning', { putMessage, emit });
          }
          await emitText(assistant, separated.text || finalText, 'text', { putMessage, emit });
        }
        const outcome = classifyTaskOutcome({ strategy, kind: waitingForUser ? 'needs_input' : 'completed' });
        return await finalizeAssistant({
          sessionId,
          assistant,
          strategy,
          usage: lastUsage,
          outcome,
          telemetry: runtime?.telemetry,
          finish: response.finish || 'stop',
          lifecycle: 'completed',
          verdict: 'completed',
          reason: outcome.reason || 'model_final',
        });
      }

      if (response.text && !streamed.text) {
        const sep = splitReasoningFromContent(response.text);
        if (sep.reasoning && !streamed.reasoning) {
          await emitText(assistant, sep.reasoning, 'reasoning', { putMessage, emit });
        }
        if (sep.text) {
          await emitText(assistant, sep.text, 'text', { putMessage, emit });
        }
      }
      frames.push({ role: 'assistant', content: response.text || '', toolCalls: calls });
      // Every card of this step is on screen (queued) before the first tool starts.
      const stepParts = toolSink.bind(calls);
      const stepMedia = [];
      // Независимые чтения одного шага идут параллельно, остальное — по очереди (см. parallel.mjs).
      let callOffset = 0;
      batches: for (const batch of planBatches(calls)) {
        const base = callOffset;
        const executed = await runBatch(batch, async (call, i) => {
          const startedAt = Date.now();
          const result = await executeCall(sessionId, assistant, call, controller, runtime, updateTurn, stepParts[base + i]);
          return { result, latencyMs: Date.now() - startedAt };
        });
        callOffset += batch.length;
        for (const [i, call] of batch.entries()) {
          const { result, latencyMs } = executed[i];
          recordToolCall(runtime.telemetry, { call, result, latencyMs });
          observeTool(strategy, call, result);
          if (runtime.recovery.resumed && !runtime.recovery.inspected && isInspectionResult(call, result))
            runtime.recovery.inspected = true;
          const toolFrame = { role: 'tool', callId: call.id, name: call.name, content: result.content, isError: result.isError };
          frames.push(toolFrame);
          if (result.visualMedia?.length) stepMedia.push(...result.visualMedia);
          checkpointState(sessionId, runtime, strategy, { phase: 'after_tool' });
          const loop = observeToolLoop(loopGuard, call, result);
          if (loop) {
            // Уже проверенный результат — остановка штатная (ниже он завершится
            // как completed). Иначе сначала предупреждаем модель и даём сменить
            // подход: ложное срабатывание (тот же `npm test` или `git status`
            // несколько раз за длинную задачу) не должно обрывать работу.
            if (loopStopSatisfiesTask(strategy) || loopWarnings >= MAX_LOOP_WARNINGS) {
              guardedStop = guardStopError(loop);
              break batches;
            }
            loopWarnings += 1;
            resetLoopGuardCounters(loopGuard);
            toolFrame.content = `${String(toolFrame.content || '')}\n\n[Runtime loop warning] ${loop.message} Repeating it will not produce new information. Change the approach: use the result you already have, inspect something else, edit the code, or finish with a final answer. If the same pattern repeats, the turn will be stopped.`;
          }
        }
      }
      // Тексты результатов инструментов не умеют нести картинки, поэтому всё,
      // что агент открыл через view_media, приходит следующим сообщением.
      if (stepMedia.length) {
        frames.push({
          role: 'user',
          content: `[Runtime] Visual content returned by view_media (${stepMedia.length} image${stepMedia.length > 1 ? 's' : ''}): ${stepMedia
            .map((m) => m.name)
            .filter(Boolean)
            .join('; ')}. This is not a new user request; continue the task using what you see.`,
          media: stepMedia.slice(0, 12),
          runtimeMedia: true,
        });
      }
    }

    if (guardedStop && loopStopSatisfiesTask(strategy)) {
      const outcome = classifyTaskOutcome({ strategy, kind: 'completed', reason: 'verified_repeat_stop' });
      // The guard can fire right after a tool call, before the model wrote a
      // conclusion: the reply then ended on a progress line («Проверяю
      // умножение.») under a green «Готово». Ask once for the final answer
      // with tools disabled; fall back to the runtime summary.
      if ((assistant.parts || []).at(-1)?.type !== 'text') {
        let finalText = '';
        try {
          frames.push({
            role: 'user',
            content: `[Runtime] ${guardedStop.message} Tool calls are disabled for the rest of this turn. Write the final answer for the user now, in the user's language, using only results you already have: what was done, what was actually checked, and what was not checked. Do not call tools.`,
          });
          const finalRes = await callModelAutopilot(ownerId, runtime.modelPlan, {
            system: [
              systemPrompt({ toolNames: [], goal, projectContext: runtime.projectContext }),
              runtimeCapabilityPrompt(),
              mediaPrompt,
              ownerPrompt,
              runtime.projectContext,
              system || '',
            ]
              .filter(Boolean)
              .join('\n\n'),
            frames: compactFrames(frames),
            tools: [],
            signal: controller.signal,
          });
          finalText = splitReasoningFromContent(String(finalRes.text || '').trim()).text || '';
        } catch (err) {
          if (!controller.signal.aborted)
            console.warn(`[turn] ${sessionId}: final answer after loop stop failed: ${String(err?.message || err).slice(0, 300)}`);
        }
        await emitText(assistant, finalText.trim() || synthesizeTurnSummary({ strategy, outcome }), 'text', { putMessage, emit });
      }
      return await finalizeAssistant({
        sessionId,
        assistant,
        strategy,
        usage: lastUsage,
        outcome,
        telemetry: runtime?.telemetry,
        finish: 'stop',
        lifecycle: 'completed',
        verdict: 'completed',
        reason: outcome.reason,
      });
    }

    const stopError = guardedStop || stepLimitError(maxSteps);
    const progress = assistantHasProgress(assistant, strategy);
    const outcome = classifyTaskOutcome({ strategy, kind: 'failed', reason: stopError.code, progress });
    const failed = outcome.status === 'failed';
    const note = guardedStop
      ? `${guardedStop.message} ${failed ? 'Безопасная защита остановила задачу.' : 'Выполненная часть сохранена; задача остановлена, чтобы не продолжать цикл.'}`
      : `Достигнут безопасный лимит ${maxSteps} шагов автономной работы. ${failed ? 'Задачу не удалось довести до результата.' : 'Выполненная часть сохранена, но задача может быть завершена не полностью.'}`;
    return await finalizeAssistant({
      sessionId,
      assistant,
      strategy,
      usage: lastUsage,
      outcome,
      telemetry: runtime?.telemetry,
      finish: failed ? 'error' : 'stop',
      note,
      error: failed ? stopError : null,
      lifecycle: failed ? 'failed' : 'completed',
      verdict: failed ? 'failed' : 'completed',
      reason: stopError.code,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      const outcome = classifyTaskOutcome({ strategy, kind: 'cancelled' });
      const summary = synthesizeTurnSummary({ strategy, outcome, note: 'Ход отменён пользователем.' });
      return await finalizeAssistant({
        sessionId,
        assistant,
        strategy,
        usage: lastUsage,
        outcome,
        telemetry: runtime?.telemetry,
        finish: 'abort',
        note: summary,
        lifecycle: 'cancelled',
        verdict: 'cancelled',
        reason: 'aborted',
      });
    }
    const modelLocked = Boolean(runtime?.modelPlan?.locked);
    const publicError =
      modelLocked && err?.modelLocked ? err?.publicMessage || err?.message || String(err) : publicProviderErrorMessage(err);
    const outcome = classifyTaskOutcome({ strategy, kind: 'failed' });
    // The error banner already states the reason. Repeating it as reply text
    // showed the same line twice and replayed it to the model on the next turn
    // as if the assistant had said it. Only a real stop report is written.
    const summary = hasStructuredSummary(strategy) ? synthesizeTurnSummary({ strategy, outcome, error: { message: publicError } }) : '';
    return await finalizeAssistant({
      sessionId,
      assistant,
      strategy,
      usage: lastUsage,
      outcome,
      telemetry: runtime?.telemetry,
      finish: 'error',
      note: summary,
      error: err,
      publicError,
      lifecycle: 'failed',
      verdict: 'failed',
      reason: 'error',
    });
  } finally {
    if (lockPulse) clearInterval(lockPulse);
    if (capacityPulse) clearInterval(capacityPulse);
    activeTurns.delete(sessionId);
    notifyTurnIdle(sessionId);
    // Фоновое обучение: не ждём и не влияем на ответ (observeTurn сам ловит любые ошибки).
    if (features.instincts && runtime?.modelPlan) {
      void observeTurn({ ownerId, sessionId, goal, assistant, strategy, modelPlan: runtime.modelPlan });
    }
  }
}
