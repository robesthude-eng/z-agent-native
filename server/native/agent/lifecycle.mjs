/**
 * Lifecycle boundary for agent turns.
 * This module is intentionally small so turn orchestration can move here
 * without changing the public agent API.
 */
export const TURN_STATES = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export function canTransition(from, to) {
  if (!from || !to) return false;
  if (from === TURN_STATES.COMPLETED || from === TURN_STATES.FAILED) return false;
  return true;
}
