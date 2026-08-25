/**
 * Agent lifecycle transition helpers.
 */
export const TURN_STATES = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
});

export function canTransition(from, to) {
  if (from === TURN_STATES.RUNNING && [TURN_STATES.WAITING, TURN_STATES.COMPLETED, TURN_STATES.FAILED, TURN_STATES.ABORTED].includes(to)) return true;
  if (from === TURN_STATES.CREATED && to === TURN_STATES.RUNNING) return true;
  return false;
}
