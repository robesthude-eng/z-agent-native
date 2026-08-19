import fs from 'node:fs';
import path from 'node:path';

const phase = process.argv[2] || 'created';
const sid = `ses_chaos${phase.replace(/[^A-Za-z0-9]/g, '')}1`;
const ownerId = 'chaos@example.com';
const actionId = `act_chaos_${phase.replace(/[^A-Za-z0-9]/g, '')}`;
const turnId = `turn_chaos_${phase.replace(/[^A-Za-z0-9]/g, '')}`;

const store = await import('../../server/native/store.mjs');
const durable = await import('../../server/native/durable-jobs.mjs');
if (!store.getUser(ownerId)) store.createUser(ownerId, 'hash');
store.createChat(sid, ownerId, `Chaos ${phase}`);
const workspace = store.workspaceFor(sid);
fs.writeFileSync(path.join(workspace, 'already.txt'), 'once\n');

const userId = `msg_user_${phase}`;
const assistantId = `msg_assistant_${phase}`;
store.putMessage({
  id: userId,
  role: 'user',
  sessionID: sid,
  parts: [{ type: 'text', text: 'Resume safely after crash' }],
  time: { created: Date.now() - 100, completed: Date.now() - 100 },
  info: { role: 'user', finish: 'stop', time: { created: Date.now() - 100, completed: Date.now() - 100 } },
});

const assistant = {
  id: assistantId,
  role: 'assistant',
  sessionID: sid,
  parts: phase === 'created' ? [] : [{
    id: 'part_existing_write',
    type: 'tool',
    tool: 'write',
    callID: 'call_existing_write',
    state: {
      status: 'completed',
      input: { path: 'already.txt', content: 'once\n' },
      output: 'Wrote already.txt',
      time: { start: Date.now() - 80, end: Date.now() - 70 },
    },
  }],
  time: { created: Date.now() - 90 },
  info: { role: 'assistant', model: 'fixture/coding-e2e', time: { created: Date.now() - 90 } },
};
if (phase === 'finalizing') {
  assistant.parts.push({ id: 'part_final_text', type: 'text', text: 'Already finalized before crash.' });
  assistant.time.completed = Date.now() - 10;
  assistant.info.finish = 'stop';
  assistant.info.outcome = { status: 'completed', reason: 'verified' };
  assistant.info.time.completed = assistant.time.completed;
}
store.putMessage(assistant);
store.claimAction(sid, actionId);
store.setTurn(sid, { turnId, lifecycle: 'running', verdict: null, reason: phase, since: Date.now() - 50 });
durable.createDurableJob({
  sessionId: sid,
  ownerId,
  actionId,
  turnId,
  userMessageId: userId,
  assistantMessageId: assistantId,
  requestedModel: { providerID: 'fixture', modelID: 'coding-e2e' },
  goal: 'Resume safely after crash',
  stepBudget: 12,
});
if (phase === 'after_tool') {
  durable.checkpointDurableJob(sid, {
    phase: 'after_tool',
    stepsUsed: 1,
    gateReminders: 0,
    strategy: { goal: 'Resume safely after crash', changed: true, needsVerification: true, verificationAttempts: 0, lastVerificationOk: null, toolErrors: 0 },
  }, { modelPlan: { candidates: [{ providerID: 'fixture', modelID: 'coding-e2e' }], explicit: true, expandOnFailure: false, goal: 'Resume safely after crash', generatedAt: Date.now() } });
}
if (phase === 'finalizing') durable.markDurableJobFinalizing(sid, { status: 'completed', reason: 'verified', completedAt: assistant.time.completed });

// The point of this helper is process death without finally/cleanup handlers.
process.kill(process.pid, 'SIGKILL');
