import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBash, compactFrames, completionGate, createTurnStrategy, observeTool, strategyGuidance } from '../server/native/context.mjs';

test('compactFrames bounds large tool observations and preserves recent tool coherence', () => {
  const frames = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_old', name: 'read', arguments: { path: 'old.txt' } }] },
    { role: 'tool', callId: 'call_old', name: 'read', content: 'x'.repeat(80_000) },
    { role: 'user', content: 'current request' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_new', name: 'grep', arguments: { query: 'needle' } }, { id: 'call_dropped', name: 'read', arguments: { path: 'huge.txt' } }] },
    { role: 'tool', callId: 'call_new', name: 'grep', content: 'y'.repeat(80_000) },
  ];

  const compacted = compactFrames(frames, { maxChars: 30_000, maxObservationChars: 8_000 });
  const recentTool = compacted.find((frame) => frame.callId === 'call_new');
  assert.ok(recentTool);
  assert.ok(recentTool.content.length <= 8_000);
  assert.match(recentTool.content, /observation compacted/);
  const recentAssistant = compacted.find((frame) => frame.role === 'assistant' && frame.toolCalls?.some((call) => call.id === 'call_new'));
  assert.ok(recentAssistant);
  assert.deepEqual(recentAssistant.toolCalls.map((call) => call.id), ['call_new']);
});

test('turn strategy requires verification after edits and clears after a successful check', () => {
  const strategy = createTurnStrategy('Fix the failing parser');
  observeTool(strategy, { name: 'edit', arguments: { path: 'parser.mjs' } }, { isError: false, metadata: {}, mutatedPaths: ['parser.mjs'] });
  assert.equal(strategy.needsVerification, true);
  assert.match(completionGate(strategy) || '', /verification/i);

  observeTool(strategy, { name: 'bash', arguments: { command: 'npm test' } }, { isError: false, metadata: { exit: 0 }, mutatedPaths: ['.'] });
  assert.equal(strategy.verificationAttempts, 1);
  assert.equal(strategy.lastVerificationOk, true);
  assert.equal(strategy.needsVerification, false);
  assert.equal(completionGate(strategy), null);
});

test('failed verification keeps the completion gate active', () => {
  const strategy = createTurnStrategy('Change behavior');
  observeTool(strategy, { name: 'write', arguments: { path: 'a.txt' } }, { isError: false, metadata: {}, mutatedPaths: ['a.txt'] });
  observeTool(strategy, { name: 'bash', arguments: { command: 'npm run typecheck' } }, { isError: false, metadata: { exit: 2 }, mutatedPaths: ['.'] });
  assert.equal(strategy.lastVerificationOk, false);
  assert.equal(strategy.needsVerification, true);
});

test('todowrite becomes pinned strategy guidance', () => {
  const strategy = createTurnStrategy('Implement feature');
  observeTool(strategy, { name: 'todowrite' }, {
    isError: false,
    metadata: { todos: [
      { content: 'Inspect code', status: 'completed', priority: 'high' },
      { content: 'Implement fix', status: 'in_progress', priority: 'high' },
    ] },
  });
  const guidance = strategyGuidance(strategy);
  assert.match(guidance, /Goal: Implement feature/);
  assert.match(guidance, /\[in_progress\] Implement fix/);
});

test('bash classification separates checks, inspection, and likely mutations', () => {
  assert.equal(classifyBash('npm test'), 'verification');
  assert.equal(classifyBash('node --check server/native/agent.mjs'), 'verification');
  assert.equal(classifyBash('git diff --check'), 'read_only');
  assert.equal(classifyBash('git log -5 --oneline'), 'read_only');
  assert.equal(classifyBash('npm install foo'), 'may_mutate');
});
