import assert from 'node:assert/strict';
import test from 'node:test';
import { compactFrames, pruneOldObservations } from '../server/native/context.mjs';

const tool = (i, size, extra = {}) => ({ role: 'tool', callId: `c${i}`, name: 'bash', content: `out${i}:${'x'.repeat(size)}`, ...extra });

test('nothing is pruned while tool output stays under the protected window', () => {
  const frames = Array.from({ length: 5 }, (_, i) => tool(i, 10_000));
  assert.deepEqual(pruneOldObservations(frames), frames);
});

test('old large outputs are cleared, the newest stay intact', () => {
  const frames = Array.from({ length: 30 }, (_, i) => tool(i, 10_000));
  const out = pruneOldObservations(frames);
  assert.match(out[0].content, /old tool output cleared/);
  assert.ok(out[0].content.startsWith('out0:'));
  assert.equal(out[29].content, frames[29].content);
  const kept = out.filter((f) => !/cleared/.test(f.content)).reduce((n, f) => n + f.content.length, 0);
  assert.ok(kept >= 120_000);
});

test('pruned set is stable between consecutive steps (cache friendly)', () => {
  const frames = Array.from({ length: 30 }, (_, i) => tool(i, 10_000));
  const a = pruneOldObservations(frames);
  const b = pruneOldObservations([...frames, tool(30, 10_000)]);
  const same = a.filter((f, i) => f.content === b[i].content).length;
  assert.ok(same >= 29, `only ${same}/30 frames unchanged`);
});

test('errors, small outputs and protected tools are never cleared; spill path is kept', () => {
  const frames = [
    tool(0, 20_000, { isError: true }),
    tool(1, 20_000, { name: 'skill' }),
    tool(2, 500),
    tool(3, 20_000, { content: `[omitted] saved to .agent-home/tool-output/123-abc.txt ${'y'.repeat(20_000)}` }),
    ...Array.from({ length: 30 }, (_, i) => tool(10 + i, 10_000)),
  ];
  const out = pruneOldObservations(frames);
  assert.equal(out[0].content, frames[0].content);
  assert.equal(out[1].content, frames[1].content);
  assert.equal(out[2].content, frames[2].content);
  assert.match(out[3].content, /\.agent-home\/tool-output\/123-abc\.txt/);
  assert.match(out[3].content, /cleared/);
});

test('pruning can be disabled and compactFrames applies it', () => {
  const frames = Array.from({ length: 30 }, (_, i) => tool(i, 10_000));
  assert.deepEqual(pruneOldObservations(frames, { protectChars: 0 }), frames);
  const out = compactFrames(frames);
  assert.match(out[0].content, /cleared/);
});
