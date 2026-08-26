import { framesFromMessages, systemPrompt, textParts } from '../agent-frames.mjs';
import { isInspectionResult, rebuildLoopGuard, rebuildStrategy, recoveryGuidance, waitForRetry } from '../agent-parts.mjs';
import {
  buildModelPlan, callModelAutopilot, modelKey, promoteModelPlan, taskStepBudget,
} from '../autopilot.mjs';
import { isClustered, releaseTurnLock, renewTurnLock } from '../cluster.mjs';
import { compactFrames, completionGate, createTurnStrategy, observeTool, shouldEnforceCompletionGate, strategyGuidance } from '../context.mjs';
import { checkpointDurableJob, markDurableJobFinalizing } from '../durable-jobs.mjs';
import { emit } from '../events.mjs';
import { getProjectContext, rememberProjectTurn } from '../project-context.mjs';
import { isNetworkTransportError, publicProviderErrorMessage } from '../providers.mjs';
import { splitReasoningFromContent } from '../reasoning-parser.mjs';
import { getTurn, listMessages, putMessage, releaseTurnCapacity, renewTurnCapacity, setTurn, workspaceFor } from '../store.mjs';
import { availableToolDefinitions } from '../tools.mjs';
import { assertTurnTransition } from '../turn-lifecycle.mjs';
import { createTurnTelemetry, finalizeTurnTelemetry, recordCompletionGate, recordModelCall, recordToolCall } from '../turn-telemetry.mjs';
import {
  classifyTaskOutcome, createLoopGuard, guardStopError, loopStopSatisfiesTask, observeToolLoop, retryDelayMs, stepLimitError,
} from '../turn-trust.mjs';
import { runtimeCapabilityPrompt } from '../workspace-policy.mjs';
import { emitText, persistAssistant } from './message-parts.mjs';
import { resumePendingQuestion } from './questions.mjs';
import { interruptedToolParts } from './recovery.mjs';
import { activeTurns, idleWaiters, TURN_CAPACITY_TTL_MS } from './state.mjs';
import { liveTextSink } from './streaming.mjs';
import { assistantHasProgress, executeCall, strategyInfo } from './tool-cycle.mjs';

export function notifyTurnIdle(sessionId) {
  if (isClustered()) { try { releaseTurnLock(sessionId); } catch {} }
  try { releaseTurnCapacity(sessionId); } catch {}
  const waiters = idleWaiters.get(sessionId);
  if (!waiters) return;
  idleWaiters.delete(sessionId);
  for (const resolve of waiters) {
    try { resolve(); } catch {}
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
    status: projection.lifecycle === 'waiting_user_input' ? 'busy' : projection.lifecycle === 'failed' ? 'error' : projection.lifecycle === 'completed' || projection.lifecycle === 'cancelled' ? 'idle' : 'busy',
    lifecycle: projection.lifecycle,
    turnID: projection.turnId,
    waiting: projection.lifecycle === 'waiting_user_input' || projection.lifecycle === 'waiting_permission',
  });
  return projection;
}

export async function finalizeAssistant({ sessionId, assistant, strategy, usage, outcome, telemetry = null, finish = 'stop', note = '', error = null, lifecycle = 'completed', verdict = 'completed', reason = 'model_final' }) {
  if (note) await emitText(assistant, note, 'text', { putMessage, emit });
  assistant.time.completed = Date.now();
  assistant.info.finish = finish;
  assistant.info.tokens = usage ? {
    input: usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokenCount,
    output: usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.candidatesTokenCount,
  } : undefined;
  assistant.info.strategy = strategyInfo(strategy);
  assistant.info.outcome = outcome;
  assistant.info.telemetry = finalizeTurnTelemetry(telemetry, { outcome, strategy, model: assistant.info.model || '', reason });
  assistant.info.time = { ...(assistant.info.time || {}), completed: assistant.time.completed };
  if (error) assistant.info.error = { message: error?.message || String(error), name: error?.name || 'Error' };
  rememberProjectTurn(sessionId, {
    goal: strategy?.goal || '',
    outcome: outcome?.status || verdict,
    model: assistant.info.model || '',
    changed: Boolean(strategy?.changed),
    summary: textParts(assistant).slice(-2_000),
  });
  persistAssistant(assistant, { putMessage, emit });
  if (assistant.info.telemetry) emit(sessionId, 'turn.telemetry', { telemetry: assistant.info.telemetry });
  try { markDurableJobFinalizing(sessionId, { status: outcome?.status || verdict, reason, completedAt: assistant.time.completed }); } catch {}
  updateTurn(sessionId, { lifecycle, verdict, since: Date.now(), reason });
  emit(sessionId, 'session.idle', {});
  return assistant;
}

export function safeAttemptInfo(attempt) {
  return {
    model: modelKey(attempt?.model),
    ok: Boolean(attempt?.ok),
    latencyMs: Math.max(0, Math.round(Number(attempt?.latencyMs) || 0)),
  };
}

export function checkpointState(sessionId, runtime, strategy, fields = {}) {
  if (isClustered()) { try { renewTurnLock(sessionId); } catch {} }
  try {
    checkpointDurableJob(sessionId, {
      phase: fields.phase || 'running',
      stepsUsed: Number(fields.stepsUsed ?? runtime.stepsUsed ?? 0),
      gateReminders: Number(fields.gateReminders ?? runtime.gateReminders ?? 0),
      lastUsage: fields.lastUsage ?? runtime.lastUsage ?? null,
      strategy: strategy ? {
        goal: strategy.goal,
        plan: strategy.plan,
        changed: strategy.changed,
        needsVerification: strategy.needsVerification,
        verificationAttempts: strategy.verificationAttempts,
        lastVerificationOk: strategy.lastVerificationOk,
        toolErrors: strategy.toolErrors,
      } : null,
      ambiguousCalls: [...(runtime.recovery?.ambiguousSignatures || [])],
      recoveryInspected: Boolean(runtime.recovery?.inspected),
    }, { modelPlan: runtime.modelPlan });
  } catch {}
}

export function synthesizeTurnSummary({ strategy, outcome, note = '', error = null }) {
  const isFailed = outcome?.status === 'failed' || error != null;
  const isPartial = outcome?.status === 'partial';
  const changed = Array.isArray(strategy?.changedPaths) && strategy.changedPaths.length > 0;
  const hasPlan = Array.isArray(strategy?.plan) && strategy.plan.length > 0;
  const hasEvidence = Boolean(strategy?.lastVerificationEvidence);

  if (!changed && !hasPlan && !hasEvidence) {
    if (isFailed) {
      return note || error?.message || 'Не удалось завершить операцию из-за ошибки.';
    }
    return 'Все компоненты и текущие изменения проверены. Система работает штатно, готов к следующей задаче.';
  }

  const lines = [];
  if (isFailed) {
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
    lines.push('**2. Выполненные пункты плана:**');
    for (const item of strategy.plan.slice(0, 10)) {
      const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '⏳' : '○';
      lines.push(`- ${mark} ${item.content}`);
    }
    lines.push('');
  }

  if (hasEvidence) {
    const v = strategy.lastVerificationEvidence;
    lines.push(`**3. Верификация:** Проверка выполнена через инструмент \`${v.tool}\` (${v.ok ? 'успешно' : 'с замечаниями'}).`);
    if (v.detail) lines.push(`> \`${v.detail.slice(0, 200)}\``);
    lines.push('');
  }

  if (isFailed || isPartial) {
    lines.push('**4. Рекомендация:**');
    lines.push('- Проверьте детали ошибки и повторите выполнение после устранения сбоя.');
  }

  const text = lines.join('\n').trim();
  return text || (isFailed ? 'Задача не была завершена из-за ошибки.' : 'Операция успешно завершена. Все действия выполнены и сохранены.');
}

export async function executeTurnLifecycle({ sessionId, ownerId, assistant, requestedModel, system, goal, controller, resume = false, job = null }) {
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
      modelPlan: job?.modelPlan?.candidates?.length ? job.modelPlan : await buildModelPlan(ownerId, requestedModel, goal),
      projectContext: await getProjectContext(sessionId, workspaceFor(sessionId), controller.signal),
      stepsUsed: Math.max(0, Number(job?.checkpoint?.stepsUsed) || 0),
      gateReminders: Math.max(0, Number(job?.checkpoint?.gateReminders) || 0),
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
        try { renewTurnLock(sessionId); } catch {}
      }, 5_000);
      lockPulse.unref?.();
    }
    capacityPulse = setInterval(() => {
      try { renewTurnCapacity(sessionId, { ttlMs: TURN_CAPACITY_TTL_MS }); } catch {}
    }, Math.min(30_000, Math.max(10_000, Math.floor(TURN_CAPACITY_TTL_MS / 3))));
    capacityPulse.unref?.();

    const workspace = workspaceFor(sessionId);
    const messages = listMessages(sessionId);
    const history = resume ? messages : messages.filter((m) => m.id !== assistant.id);
    const frames = framesFromMessages(history, workspace);
    const maxSteps = Math.max(1, Math.min(128, Number(job?.stepBudget) || taskStepBudget(goal)));
    const rebuilt = resume ? rebuildLoopGuard(assistant) : { guard: createLoopGuard(), stop: null };
    const loopGuard = rebuilt.guard;
    let guardedStop = rebuilt.stop ? guardStopError(rebuilt.stop) : null;
    let networkModelRetries = 0;

    for (let step = runtime.stepsUsed; step < maxSteps && !guardedStop; step++) {
      if (controller.signal.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
      runtime.stepsUsed = step;
      checkpointState(sessionId, runtime, strategy, { phase: 'before_model', stepsUsed: step });
      const live = liveTextSink(assistant);
      const providerFrames = compactFrames(frames);
      const modelStartedAt = Date.now();
      let response;
      try {
        response = await callModelAutopilot(ownerId, runtime.modelPlan, {
          system: [systemPrompt(), runtimeCapabilityPrompt(), runtime.projectContext, recoveryGuidance(runtime.recovery), strategyGuidance(strategy), system || ''].filter(Boolean).join('\n\n'),
          frames: providerFrames,
          tools: availableToolDefinitions(),
          signal: controller.signal,
          onTextDelta: (delta, type = null) => live.push(delta, type),
        });
      } catch (err) {
        if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
        if (isNetworkTransportError(err) && networkModelRetries < 2) {
          networkModelRetries += 1;
          live.finish();
          await waitForRetry(retryDelayMs(networkModelRetries - 1), controller.signal);
          step -= 1;
          continue;
        }
        throw err;
      }
      recordModelCall(runtime.telemetry, { response, latencyMs: Date.now() - modelStartedAt, contextChars: JSON.stringify(providerFrames).length });
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
      if (calls.length === 0) {
        if (shouldEnforceCompletionGate(strategy, runtime.gateReminders)) {
          const gate = completionGate(strategy);
          runtime.gateReminders += 1;
          recordCompletionGate(runtime.telemetry);
          frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
          frames.push({ role: 'user', content: `${gate}\nReminder attempt: ${runtime.gateReminders}.` });
          checkpointState(sessionId, runtime, strategy, { phase: 'completion_gate', gateReminders: runtime.gateReminders });
          continue;
        }
        const reasoningOnly = Boolean(response.textFromReasoning) && streamed.reasoning;
        let finalText = reasoningOnly ? '' : String(response.text || '').trim();
        if (!finalText && step > 0) {
          try {
            frames.push({ role: 'assistant', content: '', toolCalls: [] });
            frames.push({
              role: 'user',
              content: '[System Instruction] All tool operations are done. Please write your final structured summary report for the user in Russian (detailing: 1. What was done/changed with file paths; 2. Verification results; 3. Final status). Do not call any tools.',
            });
            const summaryRes = await callModelAutopilot(ownerId, runtime.modelPlan, {
              system: [systemPrompt(), runtimeCapabilityPrompt(), runtime.projectContext, system || ''].filter(Boolean).join('\n\n'),
              frames: compactFrames(frames),
              tools: [],
              signal: controller.signal,
            });
            finalText = String(summaryRes.text || '').trim();
          } catch {}
        }
        if (!finalText && reasoningOnly) finalText = String(response.text || '').trim();
        if (!finalText) {
          const outcome = classifyTaskOutcome({ strategy, kind: 'completed' });
          finalText = synthesizeTurnSummary({ strategy, outcome });
        }
        if (!streamed.text) {
          const separated = splitReasoningFromContent(finalText);
          if (separated.reasoning && !streamed.reasoning) {
            await emitText(assistant, separated.reasoning, 'reasoning', { putMessage, emit });
          }
          await emitText(assistant, separated.text || finalText, 'text', { putMessage, emit });
        }
        const outcome = classifyTaskOutcome({ strategy, kind: 'completed' });
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
      for (const call of calls) {
        const toolStartedAt = Date.now();
        const result = await executeCall(sessionId, assistant, call, controller, runtime, updateTurn);
        recordToolCall(runtime.telemetry, { call, result, latencyMs: Date.now() - toolStartedAt });
        observeTool(strategy, call, result);
        if (runtime.recovery.resumed && !runtime.recovery.inspected && isInspectionResult(call, result)) runtime.recovery.inspected = true;
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: result.content, isError: result.isError });
        checkpointState(sessionId, runtime, strategy, { phase: 'after_tool' });
        const loop = observeToolLoop(loopGuard, call, result);
        if (loop?.stop) {
          guardedStop = guardStopError(loop.stop);
          break;
        }
      }
    }

    if (guardedStop) {
      const satisfies = loopStopSatisfiesTask(guardedStop.kind, strategy);
      const outcome = classifyTaskOutcome({ strategy, kind: 'loop_guard', stopKind: guardedStop.kind, satisfies });
      const summary = synthesizeTurnSummary({ strategy, outcome, note: guardedStop.message });
      return await finalizeAssistant({
        sessionId,
        assistant,
        strategy,
        usage: lastUsage,
        outcome,
        telemetry: runtime?.telemetry,
        finish: 'stop',
        note: summary,
        lifecycle: 'completed',
        verdict: 'completed',
        reason: guardedStop.kind,
      });
    }

    const outcome = classifyTaskOutcome({ strategy, kind: 'step_limit' });
    const limitError = stepLimitError(maxSteps);
    const summary = synthesizeTurnSummary({ strategy, outcome, error: limitError });
    return await finalizeAssistant({
      sessionId,
      assistant,
      strategy,
      usage: lastUsage,
      outcome,
      telemetry: runtime?.telemetry,
      finish: 'length',
      note: summary,
      error: limitError,
      lifecycle: 'failed',
      verdict: 'failed',
      reason: 'step_limit',
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
    const _errorText = modelLocked && err?.modelLocked
      ? (err?.publicMessage || err?.message || String(err))
      : assistantHasProgress(assistant, strategy)
        ? `Работа остановилась: ${publicProviderErrorMessage(err)}`
        : publicProviderErrorMessage(err);
    const outcome = classifyTaskOutcome({ strategy, kind: 'failed' });
    const summary = synthesizeTurnSummary({ strategy, outcome, error: err });
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
      lifecycle: 'failed',
      verdict: 'failed',
      reason: 'error',
    });
  } finally {
    if (lockPulse) clearInterval(lockPulse);
    if (capacityPulse) clearInterval(capacityPulse);
    activeTurns.delete(sessionId);
    notifyTurnIdle(sessionId);
  }
}
