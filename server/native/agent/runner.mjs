import { emit } from '../events.mjs';
import { messageId, turnId } from '../ids.mjs';
import {
  clearTurn, getChat, getTurn, listMessages, putMessage, releaseTurnCapacity, renameChat, reserveTurnCapacity, setTurn, workspaceFor,
} from '../store.mjs';
import { taskStepBudget } from '../autopilot.mjs';
import { clearDurableJob, createDurableJob, getDurableJob } from '../durable-jobs.mjs';
import { clearProjectContext } from '../project-context.mjs';
import { acquireTurnLock, isClustered, releaseTurnLock } from '../cluster.mjs';
import { promptText, userPartsFromPrompt } from '../agent-frames.mjs';
import { recordTurnCapacityRejection } from '../metrics.mjs';
import { assertTurnTransition } from '../turn-lifecycle.mjs';
import {
  activeActions, activeTurns, idleWaiters, MAX_ACTIVE_TURNS, MAX_ACTIVE_TURNS_PER_OWNER, questionWaiters, resetRuntimeState, TURN_CAPACITY_TTL_MS,
} from './state.mjs';
import { persistAssistant } from './message-parts.mjs';
import { notifyTurnIdle, updateTurn, executeTurnLifecycle } from './turn-loop.mjs';
import { startDurableRecovery as startDurableRecoveryImpl } from './recovery.mjs';

export async function runTurn(sessionId, ownerId, parts, model = null, system = '', actionId = null) {
  if (activeTurns.has(sessionId)) {
    throw Object.assign(new Error('Сессия занята предыдущей задачей. Дождитесь завершения.'), { statusCode: 409, code: 'SESSION_BUSY' });
  }
  if (isClustered()) {
    const claim = acquireTurnLock(sessionId);
    if (!claim.ok) throw Object.assign(new Error('Сессия выполняется на другом узле кластера.'), { statusCode: 409, code: 'CLUSTER_LOCKED', holder: claim.holder || null });
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
    persistAssistant(assistant, { putMessage, emit });

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
    activeTurns.delete(sessionId);
    notifyTurnIdle(sessionId);
    const settled = ['failed', 'cancelled', 'completed'].includes(String(getTurn(sessionId)?.lifecycle || ''));
    if (!settled) {
      const next = { turnId: tId, lifecycle: 'failed', verdict: 'failed', reason: err?.message || String(err), since: Date.now() };
      assertTurnTransition(getTurn(sessionId), next);
      setTurn(sessionId, next);
      emit(sessionId, 'session.status', { status: 'error', lifecycle: 'failed', turnID: tId, waiting: false });
    }
    if (!actionId) clearDurableJob(sessionId);
    throw err;
  }
}

export function startDurableRecovery() {
  return startDurableRecoveryImpl(executeTurnLifecycle, updateTurn);
}

export function abortTurn(sessionId) {
  const active = activeTurns.get(sessionId);
  if (!active) return false;
  active.controller.abort();
  for (const [_id, waiter] of questionWaiters) if (waiter.sessionId === sessionId) waiter.reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
  return true;
}

export function isTurnActive(sessionId) {
  return activeTurns.has(sessionId);
}

export function activeTurnCount() {
  return activeTurns.size;
}

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
  resetRuntimeState();
  for (const sessionId of sessions) notifyTurnIdle(sessionId);
}
