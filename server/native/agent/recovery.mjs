import { emit } from '../events.mjs';
import { clearTurn, completeAction, failAction, getChat, getTurn, listMessages, putMessage, reserveTurnCapacity, setTurn } from '../store.mjs';
import { clearDurableJob, listDurableJobs, markDurableJobResuming } from '../durable-jobs.mjs';
import { acquireTurnLock, isClustered, releaseTurnLock } from '../cluster.mjs';
import { assertTurnTransition } from '../turn-lifecycle.mjs';
import { recordTurnCapacityRejection } from '../metrics.mjs';
import { toolCallFromPart, toolCallSignature, toolMayHaveSideEffects } from '../agent-parts.mjs';
import { persistAssistant } from './message-parts.mjs';
import { activeActions, activeTurns, MAX_ACTIVE_TURNS, MAX_ACTIVE_TURNS_PER_OWNER, TURN_CAPACITY_TTL_MS } from './state.mjs';
import { executeTurnLifecycle, notifyTurnIdle, updateTurn } from './turn-loop.mjs';

export function completedAssistant(message) {
  return Boolean(message?.time?.completed || message?.info?.time?.completed || message?.info?.finish);
}

export function repairFinalizedJob(job, assistant) {
  const outcome = String(assistant?.info?.outcome?.status || 'completed');
  const failed = outcome === 'failed';
  const cancelled = outcome === 'cancelled';
  if (job.actionId) {
    if (failed) failAction(job.sessionId, job.actionId, new Error(assistant?.info?.error?.message || 'Recovered turn failed'));
    else completeAction(job.sessionId, job.actionId, assistant);
  }
  const lifecycle = failed ? 'failed' : cancelled ? 'cancelled' : 'completed';
  const verdict = failed ? 'failed' : cancelled ? 'cancelled' : 'completed';
  {
    const next = { turnId: job.turnId, lifecycle, verdict, reason: 'runtime_recovered_final', since: Date.now() };
    assertTurnTransition(getTurn(job.sessionId), next);
    setTurn(job.sessionId, next);
  }
  emit(job.sessionId, 'session.status', { status: failed ? 'error' : 'idle' });
  emit(job.sessionId, 'session.idle', { reason: 'runtime_recovered_final' });
  clearDurableJob(job.sessionId);
  setTimeout(() => clearTurn(job.sessionId), 1500).unref?.();
}

export function interruptedToolParts(assistant) {
  const ambiguous = [];
  let changed = false;
  for (const part of assistant.parts || []) {
    if (part?.type !== 'tool') continue;
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    if (!['running', 'pending'].includes(String(state.status || ''))) continue;
    const call = toolCallFromPart(part);
    // A card that was still queued or only being typed by the model never started
    // executing, so nothing could have been partially applied.
    const neverStarted = String(state.status) === 'pending' || Boolean(state.metadata?.streamingArgs);
    const sideEffects = !neverStarted && toolMayHaveSideEffects(call.name);
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
  if (changed) persistAssistant(assistant, { putMessage, emit });
  return ambiguous;
}

export async function resumeDurableJob(job, controller, assistant) {
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
 * executeTurnLifecycle only cleans up after itself once its main try-block is
 * entered. A failure in its setup (before that point) would leave the session
 * registered as active, its capacity/cluster lock held and the turn stuck in
 * "running": every later message would get 409 until the process restarted.
 * Mirrors the cleanup runTurn already does for fresh turns.
 */
export function settleFailedRecovery(job, assistant, err) {
  // Only touch state this recovery still owns: a normal exit already cleaned up
  // and a newer turn may have taken over the session since.
  const owned = activeTurns.get(job.sessionId);
  if (owned && owned.turnId === job.turnId) {
    activeTurns.delete(job.sessionId);
    notifyTurnIdle(job.sessionId);
  }
  try {
    if (assistant && !completedAssistant(assistant)) {
      const now = Date.now();
      assistant.time = { ...(assistant.time || {}), completed: now };
      assistant.info = {
        ...(assistant.info || {}),
        finish: 'error',
        error: { message: String(err?.message || err || 'Recovery failed').slice(0, 500), name: err?.name || 'Error' },
        time: { ...(assistant.info?.time || {}), completed: now },
      };
      persistAssistant(assistant, { putMessage, emit });
    }
    const current = getTurn(job.sessionId);
    if (current?.turnId === job.turnId && !['failed', 'cancelled', 'completed'].includes(String(current?.lifecycle || ''))) {
      const next = { turnId: job.turnId, lifecycle: 'failed', verdict: 'failed', reason: 'recovery_failed', since: Date.now() };
      assertTurnTransition(current, next);
      setTurn(job.sessionId, next);
      emit(job.sessionId, 'session.status', { status: 'error', lifecycle: 'failed', turnID: job.turnId, waiting: false });
      emit(job.sessionId, 'session.idle', { reason: 'recovery_failed' });
    }
  } catch (cleanupErr) {
    console.error('[durable-recovery] cleanup failed', job.sessionId, cleanupErr);
  }
}

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
        settleFailedRecovery(job, assistant, err);
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
