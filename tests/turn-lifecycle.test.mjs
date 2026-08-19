import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTurnTransition, isTerminalTurnLifecycle } from '../server/native/turn-lifecycle.mjs';

test('turn lifecycle permits expected running/waiting/terminal transitions', () => {
  assert.doesNotThrow(() => assertTurnTransition(null, { turnId: 'a', lifecycle: 'running' }));
  assert.doesNotThrow(() => assertTurnTransition({ turnId: 'a', lifecycle: 'running' }, { turnId: 'a', lifecycle: 'waiting_user_input' }));
  assert.doesNotThrow(() => assertTurnTransition({ turnId: 'a', lifecycle: 'waiting_user_input' }, { turnId: 'a', lifecycle: 'running' }));
  assert.doesNotThrow(() => assertTurnTransition({ turnId: 'a', lifecycle: 'running' }, { turnId: 'a', lifecycle: 'completed' }));
  assert.equal(isTerminalTurnLifecycle('completed'), true);
});

test('terminal turn cannot be resurrected but a different turn id may start', () => {
  assert.throws(() => assertTurnTransition({ turnId: 'a', lifecycle: 'completed' }, { turnId: 'a', lifecycle: 'running' }), /invalid turn lifecycle/i);
  assert.doesNotThrow(() => assertTurnTransition({ turnId: 'a', lifecycle: 'completed' }, { turnId: 'b', lifecycle: 'running' }));
  assert.throws(() => assertTurnTransition({ turnId: 'a', lifecycle: 'completed' }, { turnId: 'b', lifecycle: 'completed' }), /new turn must start/i);
});


test('runtime-restart failure may resume only through the explicit durable-recovery transition', () => {
  const previous = { turnId: 'turn_recover', lifecycle: 'failed', reason: 'runtime_restart' };
  const next = { turnId: 'turn_recover', lifecycle: 'running', reason: 'runtime_resume' };
  assert.throws(() => assertTurnTransition(previous, next), /Invalid turn lifecycle transition/);
  assert.equal(assertTurnTransition(previous, next, { allowRuntimeRestartRecovery: true }), true);
  assert.throws(() => assertTurnTransition({ ...previous, reason: 'model_error' }, next, { allowRuntimeRestartRecovery: true }), /Invalid turn lifecycle transition/);
});
