export const TURN_LIFECYCLES = ['running', 'waiting_user_input', 'completed', 'failed', 'cancelled'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ALLOWED = new Map([
  ['running', new Set(['running', 'waiting_user_input', 'completed', 'failed', 'cancelled'])],
  ['waiting_user_input', new Set(['waiting_user_input', 'running', 'failed', 'cancelled'])],
  ['completed', new Set(['completed'])],
  ['failed', new Set(['failed'])],
  ['cancelled', new Set(['cancelled'])],
]);

export function isTerminalTurnLifecycle(value) { return TERMINAL.has(String(value || '')); }

/**
 * Validate the persisted lifecycle as a state machine scoped to one turn ID.
 * A different turn ID may start only at `running`; terminal states can never be
 * resurrected within the same turn.
 */
export function assertTurnTransition(previous, next, options = {}) {
  const nextLifecycle = String(next?.lifecycle || '');
  if (!TURN_LIFECYCLES.includes(nextLifecycle)) throw new Error(`Unknown turn lifecycle: ${nextLifecycle || '(empty)'}`);
  if (!previous?.lifecycle) {
    if (nextLifecycle !== 'running' && !TERMINAL.has(nextLifecycle)) throw new Error(`New turn cannot start at ${nextLifecycle}`);
    return true;
  }
  const previousTurnId = String(previous.turnId || previous.turn_id || '');
  const nextTurnId = String(next.turnId || next.turn_id || '');
  if (previousTurnId && nextTurnId && previousTurnId !== nextTurnId) {
    if (nextLifecycle !== 'running') throw new Error(`A new turn must start at running, not ${nextLifecycle}`);
    return true;
  }
  const from = String(previous.lifecycle || '');
  const explicitRestartRecovery = options.allowRuntimeRestartRecovery === true
    && from === 'failed'
    && String(previous.reason || '') === 'runtime_restart'
    && nextLifecycle === 'running';
  if (!explicitRestartRecovery && !ALLOWED.get(from)?.has(nextLifecycle)) throw new Error(`Invalid turn lifecycle transition: ${from} -> ${nextLifecycle}`);
  return true;
}
