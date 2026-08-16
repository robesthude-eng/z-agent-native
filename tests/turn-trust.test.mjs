import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTaskOutcome,
  createLoopGuard,
  observeToolLoop,
  shouldRetryToolCall,
} from '../server/native/turn-trust.mjs';

test('loop guard trips only when the same call produces the same result repeatedly', () => {
  const guard = createLoopGuard({ consecutiveLimit: 3 });
  const call = { name: 'read', arguments: { path: 'a.txt' } };
  assert.equal(observeToolLoop(guard, call, { content: 'v1', isError: false }), null);
  assert.equal(observeToolLoop(guard, call, { content: 'v1', isError: false }), null);
  const stop = observeToolLoop(guard, call, { content: 'v1', isError: false });
  assert.equal(stop?.code, 'repeated_tool_result');

  const changed = createLoopGuard({ consecutiveLimit: 3 });
  assert.equal(observeToolLoop(changed, call, { content: 'v1', isError: false }), null);
  assert.equal(observeToolLoop(changed, call, { content: 'v2', isError: false }), null);
  assert.equal(observeToolLoop(changed, call, { content: 'v2', isError: false }), null);
});

test('tool retry is limited to transient errors on idempotent tools', () => {
  const transient = Object.assign(new Error('HTTP 503: service unavailable'), { code: 'EAI_AGAIN' });
  assert.equal(shouldRetryToolCall({ name: 'webfetch' }, transient, 0), true);
  assert.equal(shouldRetryToolCall({ name: 'read' }, transient, 0), true);
  assert.equal(shouldRetryToolCall({ name: 'write' }, transient, 0), false);
  assert.equal(shouldRetryToolCall({ name: 'bash' }, transient, 0), false);
  assert.equal(shouldRetryToolCall({ name: 'ensure_environment' }, transient, 0), false);
  assert.equal(shouldRetryToolCall({ name: 'read' }, transient, 1), false);
  assert.equal(shouldRetryToolCall({ name: 'read' }, new Error('File not found'), 0), false);
});

test('task outcome distinguishes complete, partial and failed work', () => {
  assert.deepEqual(
    classifyTaskOutcome({ strategy: { plan: [], needsVerification: false }, kind: 'completed' }),
    { status: 'completed', label: 'Готово', reason: 'completed' },
  );

  const partial = classifyTaskOutcome({
    strategy: {
      changed: true,
      needsVerification: true,
      plan: [{ content: 'finish', status: 'pending' }],
    },
    kind: 'completed',
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.label, 'Частично выполнено');

  const failedAfterProgress = classifyTaskOutcome({ strategy: { plan: [] }, kind: 'failed', progress: true });
  assert.equal(failedAfterProgress.status, 'partial');

  const failedWithoutProgress = classifyTaskOutcome({ strategy: { plan: [] }, kind: 'failed', progress: false });
  assert.equal(failedWithoutProgress.status, 'failed');
  assert.equal(failedWithoutProgress.label, 'Ошибка');
});
