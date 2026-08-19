import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-telemetry-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_TELEMETRY_FILE = path.join(root, 'telemetry.jsonl');

const telemetry = await import('../server/native/turn-telemetry.mjs');

test('turn telemetry aggregates model/tool/gate evidence and persists one JSONL summary', () => {
  const state = telemetry.createTurnTelemetry({ sessionId: 'ses_telemetry1', turnId: 'turn_1', goal: 'change and verify' });
  telemetry.recordModelCall(state, {
    response: { attempts: [{ ok: false }, { ok: true }], usage: { prompt_tokens: 100, completion_tokens: 25 } },
    latencyMs: 120,
    contextChars: 12345,
  });
  telemetry.recordToolCall(state, { call: { name: 'write' }, result: { isError: false, metadata: { retryCount: 1 } }, latencyMs: 10 });
  telemetry.recordToolCall(state, { call: { name: 'run_tests' }, result: { isError: false }, latencyMs: 40 });
  telemetry.recordCompletionGate(state);
  const summary = telemetry.finalizeTurnTelemetry(state, {
    outcome: { status: 'completed', reason: 'verified' },
    strategy: { changed: true, verificationAttempts: 1, lastVerificationOk: true },
    model: 'fixture/coding-e2e',
    reason: 'verified',
  });
  assert.equal(summary.modelCalls, 1);
  assert.equal(summary.fallbackAttempts, 1);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.toolRetries, 1);
  assert.equal(summary.tokens.input, 100);
  assert.equal(summary.tokens.output, 25);
  assert.equal(summary.gateReminders, 1);
  assert.equal(summary.lastVerificationOk, true);
  const lines = fs.readFileSync(process.env.Z_AGENT_TELEMETRY_FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.turnId, 'turn_1');
  assert.equal(persisted.tools.run_tests.calls, 1);
});


test('turn telemetry can estimate cost from operator-supplied model pricing without hard-coded prices', () => {
  const previous = process.env.Z_AGENT_MODEL_PRICING_JSON;
  try {
    process.env.Z_AGENT_MODEL_PRICING_JSON = JSON.stringify({ 'fixture/costed': { inputPerMillion: 2, outputPerMillion: 8 } });
    const state = telemetry.createTurnTelemetry({ sessionId: 'ses_cost', turnId: 'turn_cost' });
    telemetry.recordModelCall(state, { response: { usage: { prompt_tokens: 1000, completion_tokens: 500 } }, latencyMs: 1 });
    const summary = telemetry.finalizeTurnTelemetry(state, { model: 'fixture/costed', outcome: { status: 'completed' }, strategy: {} });
    assert.equal(summary.estimatedCostUsd, 0.006);
  } finally {
    if (previous == null) delete process.env.Z_AGENT_MODEL_PRICING_JSON; else process.env.Z_AGENT_MODEL_PRICING_JSON = previous;
  }
});
