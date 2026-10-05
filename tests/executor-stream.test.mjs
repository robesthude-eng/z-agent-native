import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutorStreamParser } from '../server/native/executor-stream.mjs';

const frame = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const done = { type: 'result', result: { code: 0, stdout: 'Готово\n', stderr: '', signal: null } };

test('executor stream decodes split UTF-8 and multiple frames before completion', () => {
  const seen = [];
  const parser = createExecutorStreamParser((stdout, stderr) => seen.push({ stdout, stderr }));
  const output = frame({ type: 'output', stdout: 'Первая строка\n', stderr: 'предупреждение\n' });
  for (const byte of output) parser.push(Buffer.from([byte]));
  assert.deepEqual(seen, [{ stdout: 'Первая строка\n', stderr: 'предупреждение\n' }]);
  parser.push(frame(done));
  assert.deepEqual(parser.finish(), done.result);
});

test('executor stream bounds each frame instead of total command lifetime', () => {
  let count = 0;
  const parser = createExecutorStreamParser(() => count++);
  const output = frame({ type: 'output', stdout: 'a'.repeat(4000), stderr: '' });
  for (let i = 0; i < 1100; i++) parser.push(output);
  parser.push(frame(done));
  assert.equal(parser.finish().code, 0);
  assert.equal(count, 1100);
  const oversized = createExecutorStreamParser();
  assert.throws(() => oversized.push(Buffer.alloc(4 * 1024 * 1024 + 1, 'a')), /exceeded/);
});

test('executor stream rejects malformed, disconnected and post-result responses', () => {
  for (const value of ['{bad}\n', '{"type":"other"}\n', '{"type":"output","stdout":3}\n']) {
    assert.throws(() => createExecutorStreamParser().push(Buffer.from(value)), /invalid|Invalid|Unknown/);
  }
  const incomplete = createExecutorStreamParser();
  incomplete.push(Buffer.from('{"type":'));
  assert.throws(() => incomplete.finish(), /incomplete/);
  assert.throws(() => createExecutorStreamParser().finish(), /without a terminal/);
  const after = createExecutorStreamParser();
  after.push(frame(done));
  assert.throws(() => after.push(frame(done)), /after terminal/);
});

test('executor stream preserves spawn failure and tolerates UI callback errors', () => {
  const failed = createExecutorStreamParser();
  failed.push(frame({ type: 'error', error: 'spawn failed', code: 'SPAWN_FAILED' }));
  assert.throws(() => failed.finish(), { message: 'spawn failed', code: 'SPAWN_FAILED' });
  const parser = createExecutorStreamParser(() => { throw new Error('UI failure'); });
  parser.push(frame({ type: 'output', stdout: 'hello', stderr: '' }));
  parser.push(frame(done));
  assert.deepEqual(parser.finish(), done.result);
});
