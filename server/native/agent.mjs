import {
  clearTurn, claimAction, completeAction, createQuestion, failAction, findQuestionForRecovery, getAction, getChat, getQuestion,
  getTurn, listMessages, putMessage, renameChat, resetAction, resolveQuestion,
  setTurn, workspaceFor, reserveTurnCapacity, renewTurnCapacity, releaseTurnCapacity,
} from './store.mjs';
import { emit } from './events.mjs';
import { assertActionId, messageId, partId, questionId, turnId } from './ids.mjs';
import {
  buildModelPlan,
  callModelAutopilot,
  modelKey,
  promoteModelPlan,
  taskStepBudget,
} from './autopilot.mjs';
import {
  checkpointDurableJob,
  clearDurableJob,
  createDurableJob,
  getDurableJob,
  listDurableJobs,
  markDurableJobFinalizing,
  markDurableJobResuming,
} from './durable-jobs.mjs';
import { clearProjectContext, getProjectContext, rememberProjectTurn } from './project-context.mjs';
import { availableToolDefinitions, executeTool, toolOutputText } from './tools.mjs';
import { isIncompleteToolCall, isNetworkTransportError } from './providers.mjs';
import { compactFrames, completionGate, createTurnStrategy, observeTool, shouldEnforceCompletionGate, strategyGuidance } from './context.mjs';
import { runSubagent } from './subagent-runner.mjs';
import { createTurnTelemetry, finalizeTurnTelemetry, recordCompletionGate, recordModelCall, recordToolCall } from './turn-telemetry.mjs';
import {
  classifyTaskOutcome,
  createLoopGuard,
  guardStopError,
  loopStopSatisfiesTask,
  observeToolLoop,
  retryDelayMs,
  shouldRetryToolCall,
  stepLimitError,
} from './turn-trust.mjs';
import { acquireTurnLock, isClustered, releaseTurnLock, renewTurnLock, turnLockHolder } from './cluster.mjs';
import { framesFromMessages, promptText, systemPrompt, textParts, userPartsFromPrompt } from './agent-frames.mjs';
import { isInspectionResult, rebuildLoopGuard, rebuildStrategy, recoveryGuidance, toolCallFromPart, toolCallSignature, toolMayHaveSideEffects, toolPart, waitForRetry } from './agent-parts.mjs';
import { assertTurnTransition } from './turn-lifecycle.mjs';
import { recordTurnCapacityRejection } from './metrics.mjs';

const activeTurns = new Map();
const activeActions = new Map();
const questionWaiters = new Map();
// sessionId -> Set<resolver>. Lets waitForTurnIdle react to the moment a turn
// ends instead of polling activeTurns every 20 ms.
const idleWaiters = new Map();
const MAX_ACTIVE_TURNS = Math.min(Math.max(Number(process.env.Z_AGENT_MAX_ACTIVE_TURNS) || 32, 1), 256);
const MAX_ACTIVE_TURNS_PER_OWNER = Math.min(Math.max(Number(process.env.Z_AGENT_MAX_ACTIVE_TURNS_PER_OWNER) || 4, 1), MAX_ACTIVE_TURNS);
const TURN_CAPACITY_TTL_MS = Math.min(Math.max(Number(process.env.Z_AGENT_TURN_CAPACITY_TTL_MS) || 120_000, 30_000), 30 * 60 * 1000);


function notifyTurnIdle(sessionId) {
  // A finished turn must stop being this replica's property: without an explicit
  // release another node could only take the session over after the lock TTL.
  if (isClustered()) { try { releaseTurnLock(sessionId); } catch { /* teardown must not depend on the lock table */ } }
  try { releaseTurnCapacity(sessionId); } catch { /* TTL is the crash backstop */ }
  const waiters = idleWaiters.get(sessionId);
  if (!waiters) return;
  idleWaiters.delete(sessionId);
  for (const resolve of waiters) {
    try { resolve(); } catch { /* a waiter must never break turn teardown */ }
  }
}

function updateTurn(sessionId, state, transitionOptions = {}) {
  const now = Date.now();
  const current = activeTurns.get(sessionId);
  const projection = {
    turnId: current?.turnId || state.turnId || turnId(),
    lifecycle: state.lifecycle,
    verdict: state.verdict ?? null,
    reason: state.reason ?? null,
    since: state.since ?? now,
  };
  assertTurnTransition(getTurn(sessionId), projection, transitionOptions);
  setTurn(sessionId, projection);
  // `status` stays a three-value field for existing clients; `lifecycle` carries
  // the detail they need to tell "working" apart from "waiting for you".
  emit(sessionId, 'session.status', {
    status: projection.lifecycle === 'waiting_user_input' ? 'busy' : projection.lifecycle === 'failed' ? 'error' : projection.lifecycle === 'completed' || projection.lifecycle === 'cancelled' ? 'idle' : 'busy',
    lifecycle: projection.lifecycle,
    turnID: projection.turnId,
    waiting: projection.lifecycle === 'waiting_user_input' || projection.lifecycle === 'waiting_permission',
  });
  return projection;
}

function persistAssistant(assistant) {
  putMessage(assistant);
  emit(assistant.sessionID, 'message.updated', { message: assistant });
}

function emitPart(assistant, part) {
  const i = assistant.parts.findIndex((p) => p.id === part.id);
  if (i === -1) assistant.parts.push(part); else assistant.parts[i] = part;
  putMessage(assistant);
  emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
}

async function emitText(assistant, text, type = 'text') {
  if (!text) return;
  const part = { id: partId(), type, text: '' };
  assistant.parts.push(part);
  emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
  const chunks = String(text).match(/[\s\S]{1,96}/g) || [];
  for (const chunk of chunks) {
    part.text += chunk;
    emit(assistant.sessionID, 'message.part.delta', { messageID: assistant.id, partID: part.id, field: 'text', delta: chunk });
  }
  putMessage(assistant);
}

function liveTextSink(assistant) {
  let part = null;
  return {
    push(delta) {
      if (!delta) return;
      if (!part) {
        part = { id: partId(), type: 'text', text: '' };
        assistant.parts.push(part);
        emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
      }
      part.text += String(delta);
      emit(assistant.sessionID, 'message.part.delta', { messageID: assistant.id, partID: part.id, field: 'text', delta: String(delta) });
    },
    finish() {
      if (part) putMessage(assistant);
      return Boolean(part?.text);
    },
  };
}

function waitWithAbort(map, id, sessionId, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      map.delete(id);
      cleanup();
      reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
    };
    map.set(id, { sessionId, resolve: (value) => { map.delete(id); cleanup(); resolve(value); }, reject: (err) => { map.delete(id); cleanup(); reject(err); } });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForQuestionAnswer(question, sessionId, signal) {
  const latest = getQuestion(question.id);
  if (latest?.status === 'answered' || latest?.status === 'rejected') return latest.answers || [];
  const waiting = waitWithAbort(questionWaiters, question.id, sessionId, signal);
  // Close the tiny race between the status read above and waiter registration.
  const afterRegistration = getQuestion(question.id);
  if (afterRegistration?.status === 'answered' || afterRegistration?.status === 'rejected') {
    questionWaiters.get(question.id)?.resolve(afterRegistration.answers || []);
  }
  return await waiting;
}

async function askQuestion(sessionId, questions, signal, onCreated = null) {
  const id = questionId();
  createQuestion(id, sessionId, questions);
  onCreated?.(id);
  updateTurn(sessionId, { lifecycle: 'waiting_user_input', since: Date.now(), reason: 'question' });
  emit(sessionId, 'question.asked', { id, questions });
  const answers = await waitForQuestionAnswer({ id }, sessionId, signal);
  updateTurn(sessionId, { lifecycle: 'running', since: Date.now(), reason: 'question_answered' });
  return { id, answers };
}

async function resumePendingQuestion(sessionId, assistant, signal) {
  const part = (assistant.parts || []).find((candidate) => {
    const status = String(candidate?.state?.status || '');
    return candidate?.type === 'tool' && candidate?.tool === 'question' && ['running', 'pending'].includes(status);
  });
  if (!part) return false;
  const inputQuestions = Array.isArray(part.state?.input?.questions) ? part.state.input.questions : [];
  const stored = part.state?.metadata?.questionId
    ? getQuestion(part.state.metadata.questionId)
    : findQuestionForRecovery(sessionId, inputQuestions);
  if (!stored || stored.sessionID !== sessionId) return false;

  updateTurn(sessionId, { lifecycle: stored.status === 'pending' ? 'waiting_user_input' : 'running', since: Date.now(), reason: 'question_recovered' });
  if (stored.status === 'pending') emit(sessionId, 'question.asked', { id: stored.id, questions: stored.questions, recovered: true });
  const answers = await waitForQuestionAnswer(stored, sessionId, signal);
  part.state = {
    ...part.state,
    status: 'completed',
    output: `User answered: ${JSON.stringify(answers)}`,
    metadata: { ...(part.state?.metadata || {}), answers, questionId: stored.id, recovered: true },
    time: { ...(part.state?.time || {}), end: Date.now() },
  };
  emitPart(assistant, part);
  updateTurn(sessionId, { lifecycle: 'running', since: Date.now(), reason: 'question_answered_after_restart' });
  return true;
}

function interruptedToolParts(assistant) {
  const ambiguous = [];
  let changed = false;
  for (const part of assistant.parts || []) {
    if (part?.type !== 'tool') continue;
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    if (!['running', 'pending'].includes(String(state.status || ''))) continue;
    const call = toolCallFromPart(part);
    const sideEffects = toolMayHaveSideEffects(call.name);
    const output = sideEffects
      ? 'Runtime restarted while this action was in flight. It was not automatically repeated because it may have partially completed. Inspect the current workspace/environment state before deciding whether a new action is needed.'
      : 'Runtime restarted before this tool result was durably confirmed. The previous call was not automatically repeated; retry it only if it is still needed.';
    part.state = {
      ...state,
      status: 'error',
      output,
      metadata: {
        ...(state.metadata || {}),
        restartInterrupted: true,
        restartAmbiguous: sideEffects,
      },
      time: { ...(state.time || {}), end: Date.now() },
    };
    if (sideEffects) ambiguous.push(toolCallSignature(call));
    changed = true;
  }
  if (changed) persistAssistant(assistant);
  return ambiguous;
}

async function executeCall(sessionId, assistant, call, controller, runtime) {
  const part = toolPart(call);
  emitPart(assistant, part);
  if (isIncompleteToolCall(call)) {
    const output = 'Аргументы инструмента обрезаны или не являются JSON. Вызов не выполнен. Повторите его с полными аргументами.';
    part.state = {
      ...part.state,
      status: 'error',
      output,
      metadata: { ...(part.state?.metadata || {}), incompleteArguments: true },
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part);
    return { content: output, isError: true, metadata: part.state.metadata, mutatedPaths: [] };
  }
  const recovery = runtime?.recovery;
  const signature = toolCallSignature(call);
  if (recovery?.resumed && recovery.ambiguousSignatures.has(signature) && !recovery.inspected) {
    part.state = {
      ...part.state,
      status: 'error',
      output: 'Blocked by durable-recovery safety: this exact mutating action may already have partially executed before the restart. Inspect current state first, then decide whether a new action is required.',
      metadata: { ...(part.state?.metadata || {}), restartGuardBlocked: true },
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part);
    return { content: part.state.output, isError: true, metadata: part.state.metadata, mutatedPaths: [] };
  }

  try {
    const workspace = workspaceFor(sessionId);
    let result;
    if (String(call.name || '').toLowerCase() === 'task') {
      const subagent = await runSubagent({ ownerId: runtime.ownerId, modelPlan: runtime.modelPlan, input: call.arguments || {}, workspace, signal: controller.signal, projectContext: runtime.projectContext, sessionId });
      result = {
        output: subagent.report,
        title: call.arguments?.description || `${subagent.kind} subagent report`,
        // A writer subagent edits the same workspace, so its mutations must reach
        // the parent turn's change tracking and rollback.
        mutatedPaths: subagent.mutatedPaths || [],
        metadata: {
          subagent: true,
          agent: subagent.kind,
          steps: subagent.steps,
          repositorySnapshot: subagent.repositorySnapshot,
          model: subagent.model,
        },
      };
    } else {
      let attempt = 0;
      while (true) {
        try {
          result = await executeTool(call.name, call.arguments || {}, { workspace, sessionId, signal: controller.signal });
          break;
        } catch (err) {
          if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
          if (!shouldRetryToolCall(call, err, attempt)) throw err;
          attempt += 1;
          part.state = {
            ...part.state,
            status: 'running',
            metadata: {
              ...(part.state?.metadata || {}),
              retryCount: attempt,
              lastRetryError: err?.message || String(err),
            },
          };
          emitPart(assistant, part);
          await waitForRetry(retryDelayMs(attempt - 1), controller.signal);
        }
      }
    }
    if (result?.kind === 'question') {
      const q = await askQuestion(sessionId, result.questions, controller.signal, (id) => {
        part.state = {
          ...part.state,
          metadata: { ...(part.state?.metadata || {}), questionId: id },
        };
        emitPart(assistant, part);
      });
      part.state = {
        ...part.state,
        status: 'completed',
        output: `User answered: ${JSON.stringify(q.answers)}`,
        metadata: { ...(part.state?.metadata || {}), answers: q.answers, questionId: q.id },
        time: { ...part.state.time, end: Date.now() },
      };
      emitPart(assistant, part);
      return { content: JSON.stringify({ answers: q.answers }), isError: false, metadata: part.state.metadata, mutatedPaths: [] };
    }
    const resultMetadata = { ...(part.state?.metadata || {}), ...(result?.metadata || {}) };
    part.state = {
      ...part.state,
      status: 'completed',
      output: toolOutputText(result),
      title: result?.title || part.state.title,
      metadata: resultMetadata,
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part);
    if (result?.mutatedPaths?.length) emit(sessionId, 'file.edited', { paths: result.mutatedPaths });
    return { content: toolOutputText(result), isError: false, metadata: resultMetadata, mutatedPaths: result?.mutatedPaths || [] };
  } catch (err) {
    part.state = {
      ...part.state,
      status: 'error',
      output: `Error: ${err?.message || String(err)}`,
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part);
    if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
    return { content: `Error: ${err?.message || String(err)}`, isError: true, metadata: part.state?.metadata || {}, mutatedPaths: [] };
  }
}

function strategyInfo(strategy) {
  return {
    changed: strategy.changed,
    changedPaths: Array.isArray(strategy.changedPaths) ? strategy.changedPaths.slice(-50) : [],
    mutationEpoch: Number(strategy.mutationEpoch) || 0,
    verificationEpoch: Number.isFinite(Number(strategy.verificationEpoch)) ? Number(strategy.verificationEpoch) : -1,
    verificationAttempts: strategy.verificationAttempts,
    lastVerificationOk: strategy.lastVerificationOk,
    lastVerificationEvidence: strategy.lastVerificationEvidence || null,
    toolErrors: strategy.toolErrors,
  };
}

function assistantHasProgress(assistant, strategy) {
  if (strategy?.changed) return true;
  if (Array.isArray(strategy?.plan) && strategy.plan.some((item) => item?.status === 'completed')) return true;
  return (assistant.parts || []).some((part) => {
    if ((part.type === 'text' || part.type === 'reasoning') && String(part.text || '').trim()) return true;
    if (part.type !== 'tool') return false;
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    return state.status === 'completed' || state.status === 'success';
  });
}

async function finalizeAssistant({ sessionId, assistant, strategy, usage, outcome, telemetry = null, finish = 'stop', note = '', error = null, lifecycle = 'completed', verdict = 'completed', reason = 'model_final' }) {
  if (note) await emitText(assistant, note, 'text');
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
  persistAssistant(assistant);
  if (assistant.info.telemetry) emit(sessionId, 'turn.telemetry', { telemetry: assistant.info.telemetry });
  try { markDurableJobFinalizing(sessionId, { status: outcome?.status || verdict, reason, completedAt: assistant.time.completed }); } catch { /* final message remains authoritative */ }
  updateTurn(sessionId, { lifecycle, verdict, since: Date.now(), reason });
  emit(sessionId, 'session.idle', {});
  return assistant;
}

function safeAttemptInfo(attempt) {
  return {
    model: modelKey(attempt?.model),
    ok: Boolean(attempt?.ok),
    latencyMs: Math.max(0, Math.round(Number(attempt?.latencyMs) || 0)),
  };
}

function checkpointState(sessionId, runtime, strategy, fields = {}) {
  // Heartbeat turn ownership on the durable-checkpoint cadence: a stalled node
  // stops renewing and its claim becomes takeable once the TTL passes.
  if (isClustered()) { try { renewTurnLock(sessionId); } catch { /* the lock TTL is the backstop */ } }
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
  } catch {
    // The original job file was written before work started. A transient
    // checkpoint-write failure must not duplicate a side effect in-process.
  }
}

async function executeTurnLifecycle({ sessionId, ownerId, assistant, requestedModel, system, goal, controller, resume = false, job = null }) {
  let strategy = resume ? rebuildStrategy(goal, assistant) : createTurnStrategy(goal);
  let lastUsage = job?.checkpoint?.lastUsage || null;
  let lockPulse = null;
  let capacityPulse = null;
  let runtime = null;

  try {
    if (resume) await resumePendingQuestion(sessionId, assistant, controller.signal);
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
    assistant.info.model = assistant.info.model || modelKey(initialModel);
    assistant.info.autopilot = {
      ...(assistant.info.autopilot || {}),
      enabled: true,
      budget: Number(job?.stepBudget) || taskStepBudget(goal),
      candidates: runtime.modelPlan.candidates.map(modelKey),
      selected: assistant.info.model || modelKey(initialModel),
      fallbackCount: Number(assistant.info.autopilot?.fallbackCount || 0),
      ...(resume ? { resumed: true, resumeCount: Number(job?.resumeCount || 0) } : {}),
    };
    checkpointState(sessionId, runtime, strategy, { phase: resume ? 'resumed' : 'prepared' });
    if (isClustered()) {
      lockPulse = setInterval(() => {
        try { renewTurnLock(sessionId); } catch { /* TTL is the backstop */ }
      }, 5_000);
      lockPulse.unref?.();
    }
    capacityPulse = setInterval(() => {
      try { renewTurnCapacity(sessionId, { ttlMs: TURN_CAPACITY_TTL_MS }); } catch { /* TTL/recovery are the backstop */ }
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
          system: [systemPrompt(), runtime.projectContext, recoveryGuidance(runtime.recovery), strategyGuidance(strategy), system || ''].filter(Boolean).join('\n\n'),
          frames: providerFrames,
          tools: availableToolDefinitions(),
          signal: controller.signal,
          onTextDelta: (delta) => live.push(delta),
        });
      } catch (err) {
        if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
        // Provider handshake drops after tools already ran used to finalize the
        // turn as "Работа остановилась" even though the work was done. One more
        // full model-plan attempt keeps the same turn going.
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
      const streamedText = live.finish();
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
        if (!streamedText) await emitText(assistant, response.text || 'Готово.', 'text');
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

      if (response.text && !streamedText) await emitText(assistant, response.text, 'text');
      frames.push({ role: 'assistant', content: response.text || '', toolCalls: calls });
      for (const call of calls) {
        const toolStartedAt = Date.now();
        const result = await executeCall(sessionId, assistant, call, controller, runtime);
        recordToolCall(runtime.telemetry, { call, result, latencyMs: Date.now() - toolStartedAt });
        observeTool(strategy, call, result);
        if (runtime.recovery.resumed && !runtime.recovery.inspected && isInspectionResult(call, result)) runtime.recovery.inspected = true;
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: result.content, isError: result.isError });
        checkpointState(sessionId, runtime, strategy, { phase: 'after_tool' });
        const loop = observeToolLoop(loopGuard, call, result);
        if (loop) {
          guardedStop = guardStopError(loop);
          break;
        }
      }
    }

    if (guardedStop && loopStopSatisfiesTask(strategy)) {
      const outcome = classifyTaskOutcome({ strategy, kind: 'completed', reason: 'verified_repeat_stop' });
      const hasText = (assistant.parts || []).some((part) => part.type === 'text' && String(part.text || '').trim());
      if (!hasText) await emitText(assistant, 'Готово.', 'text');
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
    // Only a user/runtime abort on THIS turn controller is a cancel.
    // Provider idle/timeout uses its own AbortController and must not look
    // like the user pressed Stop — that used to kill a 30-minute session.
    const cancelled = controller.signal.aborted;
    if (cancelled) {
      const outcome = classifyTaskOutcome({ strategy, kind: 'cancelled', reason: 'user_cancelled' });
      return await finalizeAssistant({
        sessionId,
        assistant,
        strategy,
        usage: lastUsage,
        outcome,
        telemetry: runtime?.telemetry,
        finish: 'stop',
        lifecycle: 'cancelled',
        verdict: 'cancelled',
        reason: err?.message || 'Turn cancelled',
      });
    }

    const progress = assistantHasProgress(assistant, strategy);
    const outcome = classifyTaskOutcome({ strategy, kind: 'failed', reason: err?.code || err?.name || 'runtime_error', progress });
    if (outcome.status === 'partial') {
      return await finalizeAssistant({
        sessionId,
        assistant,
        strategy,
        usage: lastUsage,
        outcome,
        telemetry: runtime?.telemetry,
        finish: 'error',
        note: `Работа остановилась из-за ошибки: ${err?.message || String(err)}. Выполненная часть сохранена.`,
        lifecycle: 'completed',
        verdict: 'completed',
        reason: outcome.reason,
      });
    }

    if (!(assistant.parts || []).some((p) => p.type === 'text')) await emitText(assistant, `Ошибка агента: ${err?.message || String(err)}`, 'text');
    await finalizeAssistant({
      sessionId,
      assistant,
      strategy,
      usage: lastUsage,
      outcome,
      telemetry: runtime?.telemetry,
      finish: 'error',
      error: err,
      lifecycle: 'failed',
      verdict: 'failed',
      reason: err?.message || String(err),
    });
    throw err;
  } finally {
    if (lockPulse) clearInterval(lockPulse);
    if (capacityPulse) clearInterval(capacityPulse);
    activeTurns.delete(sessionId);
    notifyTurnIdle(sessionId);
    setTimeout(() => {
      if (!activeTurns.has(sessionId)) clearTurn(sessionId);
    }, 1500).unref?.();
  }
}

export function submitTurn(args) {
  const rawActionId = String(args.actionId || '').trim();
  const actionId = rawActionId ? assertActionId(rawActionId) : '';
  if (!actionId) return runTurn(args);
  const key = `${args.sessionId}:${actionId}`;
  const active = activeActions.get(key);
  if (active) return active;
  const prior = getAction(args.sessionId, actionId);
  if (prior?.state === 'completed' && prior.result) return Promise.resolve(prior.result);
  // A failed attempt must not poison the idempotency key forever: retrying the
  // same submission after a transient failure is legitimate.
  if (prior?.state === 'failed') resetAction(args.sessionId, actionId);
  if (prior?.state === 'running') return Promise.reject(Object.assign(new Error('This action is already running'), { statusCode: 409 }));
  claimAction(args.sessionId, actionId);
  const promise = runTurn({ ...args, actionId })
    .then((result) => {
      completeAction(args.sessionId, actionId, result);
      clearDurableJob(args.sessionId);
      return result;
    })
    .catch((err) => {
      failAction(args.sessionId, actionId, err);
      clearDurableJob(args.sessionId);
      throw err;
    })
    .finally(() => activeActions.delete(key));
  activeActions.set(key, promise);
  return promise;
}

export async function runTurn({ sessionId, ownerId, parts, model, system, actionId = '' }) {
  if (activeTurns.has(sessionId)) throw Object.assign(new Error('Агент уже выполняет задачу в этом чате'), { statusCode: 409 });
  // activeTurns only knows this process. With Z_AGENT_CLUSTER on, ownership of a
  // session is claimed in SQLite so two replicas cannot run the same turn.
  if (isClustered() && !acquireTurnLock(sessionId).ok) {
    throw Object.assign(new Error('Агент уже выполняет задачу в этом чате'), { statusCode: 409, holder: turnLockHolder(sessionId)?.instanceId || null });
  }
  const capacity = reserveTurnCapacity(sessionId, ownerId, { maxGlobal: MAX_ACTIVE_TURNS, maxPerOwner: MAX_ACTIVE_TURNS_PER_OWNER, ttlMs: TURN_CAPACITY_TTL_MS });
  if (!capacity.ok) {
    if (isClustered()) { try { releaseTurnLock(sessionId); } catch {} }
    recordTurnCapacityRejection(capacity.reason);
    throw Object.assign(new Error('Лимит одновременных задач исчерпан. Повторите позже.'), { statusCode: 429, code: 'TURN_CAPACITY', reason: capacity.reason });
  }
  const tId = turnId();
  const goal = promptText(parts);
  const stepBudget = taskStepBudget(goal);
  const userMessageId = messageId();
  const assistantMessageId = messageId();
  try {
    createDurableJob({
      sessionId,
      ownerId,
      actionId,
      turnId: tId,
      userMessageId,
      assistantMessageId,
      requestedModel: model,
      goal,
      stepBudget,
    });
  } catch (err) {
    if (isClustered()) { try { releaseTurnLock(sessionId); } catch {} }
    try { releaseTurnCapacity(sessionId); } catch {}
    throw err;
  }

  const controller = new AbortController();
  activeTurns.set(sessionId, { controller, turnId: tId, ownerId });

  try {
    updateTurn(sessionId, { turnId: tId, lifecycle: 'running', since: Date.now(), reason: 'user_message' });

    const workspace = workspaceFor(sessionId);
    const userMessage = {
      id: userMessageId, role: 'user', sessionID: sessionId,
      parts: userPartsFromPrompt(parts, workspace),
      time: { created: Date.now(), completed: Date.now() },
      info: { role: 'user', finish: 'stop', time: { created: Date.now(), completed: Date.now() } },
    };
    putMessage(userMessage);
    emit(sessionId, 'message.updated', { message: userMessage });

    const chat = getChat(sessionId, ownerId);
    if (chat?.title === 'Новый чат') {
      const first = goal.split('\n')[0].trim().slice(0, 72);
      if (first) {
        const updated = renameChat(sessionId, ownerId, first);
        if (updated) emit(sessionId, 'session.updated', { session: updated });
      }
    }

    const assistant = {
      id: assistantMessageId, role: 'assistant', sessionID: sessionId, parts: [],
      time: { created: Date.now() },
      info: { role: 'assistant', time: { created: Date.now() } },
    };
    persistAssistant(assistant);

    const result = await executeTurnLifecycle({
      sessionId,
      ownerId,
      assistant,
      requestedModel: model,
      system,
      goal,
      controller,
      resume: false,
      job: getDurableJob(sessionId),
    });
    if (!actionId) clearDurableJob(sessionId);
    return result;
  } catch (err) {
    // executeTurnLifecycle already cleared activeTurns in its own finally block,
    // so gating on activeTurns.has() meant this projection was never written and
    // the session could stay "busy" in the UI after a crash.
    activeTurns.delete(sessionId);
    notifyTurnIdle(sessionId);
    const settled = ['failed', 'cancelled', 'completed'].includes(String(getTurn(sessionId)?.lifecycle || ''));
    if (!settled) {
      { const next = { turnId: tId, lifecycle: 'failed', verdict: 'failed', reason: err?.message || String(err), since: Date.now() }; assertTurnTransition(getTurn(sessionId), next); setTurn(sessionId, next); }
      emit(sessionId, 'session.status', { status: 'error', lifecycle: 'failed', turnID: tId, waiting: false });
    }
    if (!actionId) clearDurableJob(sessionId);
    throw err;
  }
}

function completedAssistant(message) {
  return Boolean(message?.time?.completed || message?.info?.time?.completed || message?.info?.finish);
}

function repairFinalizedJob(job, assistant) {
  const outcome = String(assistant?.info?.outcome?.status || 'completed');
  const failed = outcome === 'failed';
  const cancelled = outcome === 'cancelled';
  if (job.actionId) {
    if (failed) failAction(job.sessionId, job.actionId, new Error(assistant?.info?.error?.message || 'Recovered turn failed'));
    else completeAction(job.sessionId, job.actionId, assistant);
  }
  const lifecycle = failed ? 'failed' : cancelled ? 'cancelled' : 'completed';
  const verdict = failed ? 'failed' : cancelled ? 'cancelled' : 'completed';
  { const next = { turnId: job.turnId, lifecycle, verdict, reason: 'runtime_recovered_final', since: Date.now() }; assertTurnTransition(getTurn(job.sessionId), next); setTurn(job.sessionId, next); }
  emit(job.sessionId, 'session.status', { status: failed ? 'error' : 'idle' });
  emit(job.sessionId, 'session.idle', { reason: 'runtime_recovered_final' });
  clearDurableJob(job.sessionId);
  setTimeout(() => clearTurn(job.sessionId), 1500).unref?.();
}

async function resumeDurableJob(job, controller, assistant) {
  const refreshed = markDurableJobResuming(job.sessionId) || job;
  return executeTurnLifecycle({
    sessionId: job.sessionId,
    ownerId: job.ownerId,
    assistant,
    requestedModel: refreshed.requestedModel || null,
    system: '',
    goal: refreshed.goal || '',
    controller,
    resume: true,
    job: refreshed,
  });
}

/**
 * Prime all recoverable jobs synchronously before the HTTP server starts. The
 * actual model work continues asynchronously, but activeTurns/activeActions and
 * the server-owned turn projection are restored immediately so a reconnecting
 * browser cannot observe a false idle window.
 */
export function startDurableRecovery() {
  let started = 0;
  for (const job of listDurableJobs()) {
    const chat = getChat(job.sessionId, job.ownerId);
    if (!chat) {
      clearDurableJob(job.sessionId);
      continue;
    }
    const assistant = listMessages(job.sessionId).find((message) => message.id === job.assistantMessageId && message.role === 'assistant');
    if (!assistant) {
      if (job.actionId) failAction(job.sessionId, job.actionId, new Error('Durable assistant checkpoint is missing'));
      clearDurableJob(job.sessionId);
      continue;
    }
    if (completedAssistant(assistant)) {
      repairFinalizedJob(job, assistant);
      continue;
    }
    if (activeTurns.has(job.sessionId)) continue;
    // Another replica may already be recovering this durable job.
    if (isClustered() && !acquireTurnLock(job.sessionId).ok) continue;
    const capacity = reserveTurnCapacity(job.sessionId, job.ownerId, { maxGlobal: MAX_ACTIVE_TURNS, maxPerOwner: MAX_ACTIVE_TURNS_PER_OWNER, ttlMs: TURN_CAPACITY_TTL_MS });
    if (!capacity.ok) {
      if (isClustered()) { try { releaseTurnLock(job.sessionId); } catch {} }
      recordTurnCapacityRejection(capacity.reason);
      continue;
    }

    const controller = new AbortController();
    activeTurns.set(job.sessionId, { controller, turnId: job.turnId, ownerId: job.ownerId, recovered: true });
    updateTurn(job.sessionId, { turnId: job.turnId, lifecycle: 'running', since: Date.now(), reason: 'runtime_resume' }, { allowRuntimeRestartRecovery: true });
    const key = job.actionId ? `${job.sessionId}:${job.actionId}` : '';
    const promise = Promise.resolve()
      .then(() => resumeDurableJob(job, controller, assistant))
      .then((result) => {
        if (job.actionId) completeAction(job.sessionId, job.actionId, result);
        clearDurableJob(job.sessionId);
        return result;
      })
      .catch((err) => {
        if (job.actionId) failAction(job.sessionId, job.actionId, err);
        clearDurableJob(job.sessionId);
        console.error('[durable-recovery]', job.sessionId, err);
        return null;
      })
      .finally(() => {
        if (key) activeActions.delete(key);
      });
    if (key) activeActions.set(key, promise);
    started += 1;
  }
  return started;
}

export function abortTurn(sessionId) {
  const active = activeTurns.get(sessionId);
  if (!active) return false;
  active.controller.abort();
  for (const [id, waiter] of questionWaiters) if (waiter.sessionId === sessionId) waiter.reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
  return true;
}

export function answerQuestion(sessionId, id, answers) {
  const q = getQuestion(id);
  if (!q || q.sessionID !== sessionId || q.status !== 'pending') return false;
  resolveQuestion(id, answers, 'answered');
  emit(sessionId, 'question.replied', { id, answers });
  const waiter = questionWaiters.get(id);
  waiter?.resolve(answers);
  return true;
}

export function rejectQuestion(sessionId, id) {
  const q = getQuestion(id);
  if (!q || q.sessionID !== sessionId || q.status !== 'pending') return false;
  resolveQuestion(id, [], 'rejected');
  emit(sessionId, 'question.rejected', { id });
  const waiter = questionWaiters.get(id);
  waiter?.resolve([]);
  return true;
}

export function isTurnActive(sessionId) { return activeTurns.has(sessionId); }
export function activeTurnCount() { return activeTurns.size; }

export async function waitForTurnIdle(sessionId, timeoutMs = 5000) {
  if (!activeTurns.has(sessionId)) return true;
  await new Promise((resolve) => {
    const waiters = idleWaiters.get(sessionId) || new Set();
    idleWaiters.set(sessionId, waiters);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      if (!waiters.size) idleWaiters.delete(sessionId);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, Number(timeoutMs) || 0));
    timer.unref?.();
    waiters.add(done);
  });
  return !activeTurns.has(sessionId);
}

export function clearAgentSessionState(sessionId) {
  if (activeTurns.has(sessionId)) return false;
  for (const key of activeActions.keys()) if (key.startsWith(`${sessionId}:`)) activeActions.delete(key);
  for (const [id, waiter] of questionWaiters) if (waiter.sessionId === sessionId) questionWaiters.delete(id);
  clearDurableJob(sessionId);
  clearProjectContext(sessionId);
  return true;
}

export function resetAgentStateForTests() {
  for (const active of activeTurns.values()) active.controller.abort();
  const sessions = [...activeTurns.keys()];
  activeTurns.clear(); activeActions.clear(); questionWaiters.clear();
  for (const sessionId of sessions) notifyTurnIdle(sessionId);
  idleWaiters.clear();
}
