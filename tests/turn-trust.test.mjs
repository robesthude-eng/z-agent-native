import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTaskOutcome,
  createLoopGuard,
  observeToolLoop,
  shouldRetryToolCall,
} from '../server/native/turn-trust.mjs';

test('loop guard trips only when the same call produces the same result repeatedly', () => {
  const guard = createLoopGuard({ consecutiveLimit: 3, callRepeatLimit: 5 });
  const call = { name: 'read', arguments: { path: 'a.txt' } };
  assert.equal(observeToolLoop(guard, call, { content: 'v1', isError: false }), null);
  assert.equal(observeToolLoop(guard, call, { content: 'v1', isError: false }), null);
  const stop = observeToolLoop(guard, call, { content: 'v1', isError: false });
  assert.equal(stop?.code, 'repeated_tool_result');

  const changed = createLoopGuard({ consecutiveLimit: 3, callRepeatLimit: 5 });
  assert.equal(observeToolLoop(changed, call, { content: 'v1', isError: false }), null);
  assert.equal(observeToolLoop(changed, call, { content: 'v2', isError: false }), null);
  assert.equal(observeToolLoop(changed, call, { content: 'v2', isError: false }), null);
});

test('loop guard treats bash variants with tail/head as the same call', () => {
  const guard = createLoopGuard({ callRepeatLimit: 3 });
  const a = { name: 'bash', arguments: { command: 'cd travian_player && pytest -q | tail -20' } };
  const b = { name: 'bash', arguments: { command: 'cd travian_player && pytest -q | tail -5' } };
  const c = { name: 'bash', arguments: { command: 'cd travian_player && pytest -q 2>&1 | head -10' } };
  assert.equal(observeToolLoop(guard, a, { content: 'out-1', isError: false }), null);
  assert.equal(observeToolLoop(guard, b, { content: 'out-2', isError: false }), null);
  const stop = observeToolLoop(guard, c, { content: 'out-3', isError: false });
  assert.equal(stop?.code, 'repeated_tool_call');
});

test('loop guard stops the same call even when other tools are in between', () => {
  const guard = createLoopGuard({ callRepeatLimit: 3 });
  const compile = { name: 'bash', arguments: { command: 'python -m py_compile app.py' } };
  const other = { name: 'read', arguments: { path: 'app.py' } };
  assert.equal(observeToolLoop(guard, compile, { content: 'ok', isError: false }), null);
  assert.equal(observeToolLoop(guard, other, { content: 'src', isError: false }), null);
  assert.equal(observeToolLoop(guard, compile, { content: 'ok', isError: false }), null);
  assert.equal(observeToolLoop(guard, other, { content: 'src', isError: false }), null);
  const stop = observeToolLoop(guard, compile, { content: 'ok', isError: false });
  assert.equal(stop?.code, 'repeated_tool_call');
  assert.match(stop.message, /3 раза повторил/);
});

test('loop guard stops a repeating verification cycle but allows read/edit', () => {
  const guard = createLoopGuard();
  const compile = { name: 'bash', arguments: { command: 'py_compile' } };
  const testCmd = { name: 'bash', arguments: { command: 'pytest -q' } };
  const hash = { name: 'bash', arguments: { command: 'sha256sum app.tar' } };
  const ok = { content: 'ok', isError: false };
  for (const call of [compile, testCmd, hash, compile, testCmd]) {
    assert.equal(observeToolLoop(guard, call, ok), null);
  }
  const stop = observeToolLoop(guard, hash, ok);
  assert.equal(stop?.code, 'cyclic_tool_sequence');

  const editLoop = createLoopGuard();
  const read = { name: 'read', arguments: { path: 'a.txt' } };
  const edit = { name: 'edit', arguments: { path: 'a.txt', oldText: 'a', newText: 'b' } };
  assert.equal(observeToolLoop(editLoop, read, { content: 'a', isError: false }), null);
  assert.equal(observeToolLoop(editLoop, edit, { content: 'edited', isError: false }), null);
  assert.equal(observeToolLoop(editLoop, read, { content: 'b', isError: false }), null);
  assert.equal(observeToolLoop(editLoop, edit, { content: 'edited', isError: false }), null);
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
