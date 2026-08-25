/**
 * Agent lifecycle runner boundary.
 *
 * This module intentionally contains lifecycle helpers only. The existing
 * agent facade remains compatible while execution stages are migrated here.
 */

export function createTurnContext(input = {}) {
  return {
    turnId: input.turnId,
    chatId: input.chatId,
    owner: input.owner,
    startedAt: Date.now(),
    metadata: input.metadata ?? {},
  };
}

export function shouldContinueLoop(state = {}) {
  if (state.aborted) return false;
  if (state.completed) return false;
  return true;
}
