import test from 'node:test';
import assert from 'node:assert/strict';

process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const { classifyBash, compactFrames, completionGate, createTurnStrategy, observeTool, shouldEnforceCompletionGate, strategyGuidance } = await import('../server/native/context.mjs');

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
  assert.equal(strategy.mutationEpoch, 1);
  assert.deepEqual(strategy.changedPaths, ['parser.mjs']);
  assert.match(completionGate(strategy) || '', /verification/i);

  observeTool(strategy, { name: 'bash', arguments: { command: 'npm test' } }, { isError: false, metadata: { exit: 0 }, mutatedPaths: ['.'] });
  assert.equal(strategy.verificationAttempts, 1);
  assert.equal(strategy.lastVerificationOk, true);
  assert.equal(strategy.needsVerification, false);
  assert.equal(strategy.verificationEpoch, strategy.mutationEpoch);
  assert.equal(strategy.lastVerificationEvidence?.tool, 'bash');
  assert.equal(completionGate(strategy), null);
});

test('a later mutation invalidates earlier verification evidence', () => {
  const strategy = createTurnStrategy('Verify, then change again');
  observeTool(strategy, { name: 'edit', arguments: { path: 'a.mjs' } }, { isError: false, metadata: {}, mutatedPaths: ['a.mjs'] });
  observeTool(strategy, { name: 'run_tests', arguments: { command: 'node --test a.test.mjs' } }, { isError: false, metadata: { tests: { exit: 0 } }, mutatedPaths: [] });
  assert.equal(strategy.needsVerification, false);
  const verifiedEpoch = strategy.verificationEpoch;
  observeTool(strategy, { name: 'edit', arguments: { path: 'b.mjs' } }, { isError: false, metadata: {}, mutatedPaths: ['b.mjs'] });
  assert.equal(strategy.mutationEpoch, verifiedEpoch + 1);
  assert.equal(strategy.needsVerification, true);
  assert.equal(strategy.lastVerificationOk, null);
  assert.equal(strategy.lastVerificationEvidence, null);
  assert.match(completionGate(strategy) || '', /latest change/i);
});

test('failed verification keeps the completion gate active', () => {
  const strategy = createTurnStrategy('Change behavior');
  observeTool(strategy, { name: 'write', arguments: { path: 'a.txt' } }, { isError: false, metadata: {}, mutatedPaths: ['a.txt'] });
  observeTool(strategy, { name: 'bash', arguments: { command: 'npm run typecheck' } }, { isError: false, metadata: { exit: 2 }, mutatedPaths: ['.'] });
  assert.equal(strategy.lastVerificationOk, false);
  assert.equal(strategy.needsVerification, true);
  assert.match(completionGate(strategy) || '', /verification/i);
});

test('dedicated verification tools satisfy the completion gate only on success', () => {
  const testsStrategy = createTurnStrategy('Fix behavior');
  observeTool(testsStrategy, { name: 'edit', arguments: { path: 'feature.mjs' } }, { isError: false, metadata: {}, mutatedPaths: ['feature.mjs'] });
  observeTool(testsStrategy, { name: 'run_tests', arguments: {} }, { isError: false, metadata: { tests: { exit: 0 } }, mutatedPaths: ['.'] });
  assert.equal(testsStrategy.verificationAttempts, 1);
  assert.equal(testsStrategy.lastVerificationOk, true);
  assert.equal(testsStrategy.needsVerification, false);

  const failedTests = createTurnStrategy('Fix behavior');
  observeTool(failedTests, { name: 'write', arguments: { path: 'feature.mjs' } }, { isError: false, metadata: {}, mutatedPaths: ['feature.mjs'] });
  observeTool(failedTests, { name: 'run_tests', arguments: {} }, { isError: false, metadata: { tests: { exit: 1 } }, mutatedPaths: ['.'] });
  assert.equal(failedTests.lastVerificationOk, false);
  assert.equal(failedTests.needsVerification, true);

  const diagnosticsStrategy = createTurnStrategy('Fix types');
  observeTool(diagnosticsStrategy, { name: 'edit', arguments: { path: 'types.ts' } }, { isError: false, metadata: {}, mutatedPaths: ['types.ts'] });
  observeTool(diagnosticsStrategy, { name: 'diagnostics', arguments: { kind: 'typecheck' } }, { isError: false, metadata: { diagnostics: { ok: true } }, mutatedPaths: [] });
  assert.equal(diagnosticsStrategy.lastVerificationOk, true);
  assert.equal(diagnosticsStrategy.needsVerification, false);
});

test('writer subagent mutations propagate into the parent completion strategy', () => {
  const strategy = createTurnStrategy('Delegate a scoped implementation');
  observeTool(strategy, { name: 'task', arguments: { agent: 'implement' } }, {
    isError: false,
    metadata: { subagent: true, agent: 'implement' },
    mutatedPaths: ['src/feature.ts'],
  });
  assert.equal(strategy.changed, true);
  assert.equal(strategy.needsVerification, true);
  assert.equal(strategy.lastVerificationOk, null);
  assert.match(completionGate(strategy) || '', /verification/i);
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
  assert.equal(classifyBash('npm test && sed -i s/a/b/ file.txt'), 'may_mutate');
  assert.equal(classifyBash('npm test 2>&1'), 'verification');
  assert.equal(classifyBash('wc -l index.html'), 'read_only');
  assert.equal(classifyBash('sha256sum app.tar'), 'read_only');
  assert.equal(classifyBash('python3 -c "assert len(open(\'index.html\').read()) > 100"'), 'verification');
  assert.equal(classifyBash('node -e "console.log(1)"'), 'verification');
  assert.equal(classifyBash('python3 -c "open(\'f\',\'w\').write(\'x\')"'), 'may_mutate');
  assert.equal(classifyBash('echo hi > out.txt'), 'may_mutate');
  assert.equal(classifyBash('python checkers_test.js'), 'verification');
  assert.equal(classifyBash('cd app && pytest -q'), 'verification');
  assert.equal(classifyBash('cd app && pytest -q | tail -20'), 'verification');
  assert.equal(classifyBash(`node -e "\nconst fs = require('fs');\nconst html = fs.readFileSync('index.html', 'utf8');\nif (html.length > 100) console.log('ok');\n"`), 'verification');
});

test('python -c checks and static HTML read-back satisfy the gate; wc does not reopen it', () => {
  const strategy = createTurnStrategy('Сделай браузерную игру шашки');
  observeTool(strategy, { name: 'write', arguments: { path: 'index.html' } }, { isError: false, mutatedPaths: ['index.html'] });
  assert.equal(strategy.needsVerification, true);

  observeTool(strategy, { name: 'bash', arguments: { command: 'python3 -c "print(open(\'index.html\').read())"' } }, { isError: false, metadata: { exit: 0 } });
  assert.equal(strategy.needsVerification, false);
  assert.equal(strategy.lastVerificationOk, true);
  assert.equal(completionGate(strategy), null);

  observeTool(strategy, { name: 'bash', arguments: { command: 'wc -l index.html' } }, { isError: false, metadata: { exit: 0 }, mutatedPaths: ['.'] });
  assert.equal(strategy.needsVerification, false);
  assert.equal(completionGate(strategy), null);

  const html = createTurnStrategy('Добавь визуализации');
  observeTool(html, { name: 'edit', arguments: { path: 'index.html' } }, { isError: false, mutatedPaths: ['index.html'] });
  observeTool(html, { name: 'read', arguments: { path: 'index.html' } }, { isError: false });
  assert.equal(html.needsVerification, false);
  assert.equal(html.lastVerificationOk, true);
  assert.equal(completionGate(html), null);
  assert.equal(shouldEnforceCompletionGate(html, 0), false);
});

test('completion gate stops nagging after a few reminders', () => {
  const strategy = createTurnStrategy('Fix parser');
  observeTool(strategy, { name: 'edit', arguments: { path: 'parser.mjs' } }, { isError: false, mutatedPaths: ['parser.mjs'] });
  assert.equal(shouldEnforceCompletionGate(strategy, 0), true);
  assert.equal(shouldEnforceCompletionGate(strategy, 2), true);
  assert.equal(shouldEnforceCompletionGate(strategy, 3), false);
});

test('opening local HTML in the browser satisfies the completion gate', () => {
  const strategy = createTurnStrategy('Сделай браузерную игру шашки');
  observeTool(strategy, { name: 'write', arguments: { path: 'index.html' } }, { isError: false, mutatedPaths: ['index.html'] });
  observeTool(strategy, { name: 'browser', arguments: { action: 'open', url: 'index.html' } }, { isError: false });
  assert.equal(strategy.needsVerification, false);
  assert.equal(strategy.lastVerificationOk, true);
  assert.equal(completionGate(strategy), null);
});
