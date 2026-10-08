import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const council = await import('../server/native/agent/council.mjs');
const { agentFeatureFlags } = await import('../server/native/user-settings-prompt.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const opts = ['Monolith', 'Microservices', 'Modular monolith'];
const vote = (choice, confidence = 0.8, extra = {}) =>
  JSON.stringify({ choice, confidence, reasoning: `because ${choice}`, risks: ['r1'], verify: '', ...extra });

test('an explicit request in the message switches the council on; ordinary text does not', () => {
  for (const t of ['Созови совет моделей по архитектуре', 'проголосуйте за вариант', 'ask the council which DB to use', 'нужен консилиум'])
    assert.equal(council.councilRequested(t), true, t);
  for (const t of ['исправь баг в совете директоров.html', 'добавь страницу', '']) assert.equal(council.councilRequested(t), false, t);
  assert.equal(agentFeatureFlags({}).council, false, 'off by default');
  assert.equal(agentFeatureFlags({ agentCouncil: true }).council, true);
});

test('input is validated and bounded', () => {
  assert.throws(() => council.normalizeCouncilInput({ question: '', options: ['a', 'b'] }), /question/);
  assert.throws(() => council.normalizeCouncilInput({ question: 'q', options: ['only one'] }), /2–5/);
  const n = council.normalizeCouncilInput({ question: 'q', options: ['a', 'b', 'c', 'd', 'e', 'f', ' '], context: 'x'.repeat(10_000) });
  assert.equal(n.options.length, 5);
  assert.equal(n.context.length, 6_000);
});

test('members: different models in Auto mode, the same locked model in distinct roles otherwise', () => {
  const auto = council.pickCouncilMembers({
    candidates: [
      { providerID: 'a', modelID: '1' },
      { providerID: 'b', modelID: '2' },
      { providerID: 'c', modelID: '3' },
    ],
  });
  assert.deepEqual(
    auto.map((m) => m.model.modelID),
    ['1', '2', '3'],
  );
  assert.deepEqual(
    auto.map((m) => m.role.id),
    ['pragmatist', 'skeptic', 'maintainer'],
  );
  const two = council.pickCouncilMembers({
    candidates: [
      { providerID: 'a', modelID: '1' },
      { providerID: 'b', modelID: '2' },
    ],
  });
  assert.deepEqual(
    two.map((m) => m.model.modelID),
    ['1', '2', '1'],
  );
  const locked = council.pickCouncilMembers({
    locked: true,
    candidates: [
      { providerID: 'a', modelID: '1' },
      { providerID: 'b', modelID: '2' },
    ],
  });
  assert.deepEqual(new Set(locked.map((m) => m.model.modelID)), new Set(['1']), 'a user-locked model never sends data elsewhere');
  assert.equal(new Set(locked.map((m) => m.role.id)).size, 3);
});

test('vote parsing and tallying', () => {
  assert.equal(council.parseVote('nonsense', 3), null);
  assert.equal(council.parseVote(vote('D'), 3), null, 'option out of range');
  assert.equal(council.parseVote(vote('b', 7), 3).confidence, 1);
  assert.equal(council.parseVote(`\`\`\`json\n${vote('A')}\n\`\`\``, 3).choice, 0);
  const v = (choice, confidence = 0.8) => ({ choice, confidence });
  assert.equal(council.tallyVotes([v(1), v(1), v(1)], 3).verdict, 'unanimous');
  const maj = council.tallyVotes([v(2), v(2), v(0)], 3);
  assert.deepEqual([maj.verdict, maj.winner], ['majority', 2]);
  assert.equal(council.tallyVotes([v(0), v(1)], 3).verdict, 'split');
  assert.equal(council.tallyVotes([v(0, 0.9), v(1, 0.6)], 3).winner, 0, 'confidence breaks a 1:1');
  assert.equal(council.tallyVotes([v(0)], 3).verdict, 'insufficient');
});

test('runCouncil: parallel members, secrets redacted, one failing member tolerated, advice not command', async () => {
  const seen = [];
  let running = 0;
  let peak = 0;
  const call = async (_o, plan, req) => {
    seen.push({ model: plan.candidates[0].modelID, system: req.system, content: req.frames[0].content });
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    if (req.system.includes('skeptic')) throw new Error('provider down');
    return { text: req.system.includes('pragmatist') ? vote('A', 0.9) : vote('C', 0.7) };
  };
  const secret = ['ghp', 'k'.repeat(30)].join('_');
  const result = await council.runCouncil({
    ownerId: 'o@example.com',
    modelPlan: {
      candidates: [
        { providerID: 'a', modelID: '1' },
        { providerID: 'b', modelID: '2' },
        { providerID: 'c', modelID: '3' },
      ],
    },
    input: { question: 'Which architecture?', options: opts, context: `we use token ${secret} in CI` },
    signal: new AbortController().signal,
    call,
  });
  assert.equal(peak, 3, 'members are polled concurrently');
  assert.ok(
    seen.every((s) => !s.content.includes(secret)),
    'secrets never reach the members',
  );
  assert.ok(seen.every((s) => s.content.includes('untrusted') && s.system.includes('untrusted data')));
  assert.match(result.output, /Council verdict: SPLIT/);
  assert.match(result.output, /\(2 of 3 members voted\)/);
  assert.match(result.output, /advice|did not converge/);
  assert.equal(result.metadata.council.votes, 2);
});

test('runCouncil: majority gives a recommendation; no usable votes is an error; abort is honoured', async () => {
  const plan = { locked: true, candidates: [{ providerID: 'a', modelID: '1' }] };
  const input = { question: 'q', options: opts };
  const ok = await council.runCouncil({ ownerId: 'o', modelPlan: plan, input, call: async () => ({ text: vote('B') }) });
  assert.match(ok.output, /UNANIMOUS — option B \("Microservices"\)/);
  assert.match(ok.output, /This is advice, not a command/);
  await assert.rejects(
    council.runCouncil({ ownerId: 'o', modelPlan: plan, input, call: async () => ({ text: 'no json' }) }),
    /could not be convened/,
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    council.runCouncil({ ownerId: 'o', modelPlan: plan, input, signal: ac.signal, call: async () => ({ text: vote('A') }) }),
    /Aborted/,
  );
});

test('the real agent loop: council tool is hidden by default, appears on an explicit request or setting, and is capped per task', async () => {
  const store = await import('../server/native/store.mjs');
  const agent = await import('../server/native/agent.mjs');
  const providers = await import('../server/native/providers.mjs');
  const configs = await import('../server/native/provider-configs.mjs');
  const owner = 'council-owner@example.com';
  store.createUser(owner, 'hash');
  configs.upsertProviderConfig(owner, {
    id: 'channel_council',
    name: 'Council test',
    protocol: 'openai',
    baseURL: 'https://1.1.1.1/v1',
    enabled: true,
  });
  store.setProviderKey(owner, 'channel_council', 'dummy-test-key');
  agent.resetAgentStateForTests();
  const sse = (delta, finish = 'stop') =>
    new Response(
      [{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]']
        .map((x) => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  let chatCalls = 0;
  let memberCalls = 0;
  let toolNamesSeen = [];
  const toolResults = [];
  providers.setProviderTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body);
    const system = String(body.messages[0]?.content || '');
    if (system.includes('decision council')) {
      memberCalls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: vote('C', 0.8) }, finish_reason: 'stop' }] }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    chatCalls++;
    toolNamesSeen = (body.tools || []).map((t) => t.function?.name);
    const last = body.messages.at(-1);
    if (last.role === 'tool') toolResults.push(String(last.content));
    if (last.role === 'tool' && toolResults.length >= 3) return sse({ content: 'Решил: модульный монолит.' });
    return sse(
      {
        tool_calls: [
          {
            index: 0,
            id: `c${chatCalls}`,
            function: {
              name: 'council',
              arguments: JSON.stringify({ question: `Архитектура, вариант ${chatCalls}?`, options: opts, context: 'небольшая команда' }),
            },
          },
        ],
      },
      'tool_calls',
    );
  });
  const run = (sid, text) => {
    store.createChat(sid, owner, sid);
    return agent.runTurn({
      sessionId: sid,
      ownerId: owner,
      parts: [{ type: 'text', text }],
      model: { providerID: 'channel_council', modelID: 'm' },
      system: '',
    });
  };
  try {
    await run('ses_councilOff', 'выбери архитектуру');
    assert.equal(toolNamesSeen.includes('council'), false, 'hidden by default');
    assert.equal(memberCalls, 0);
    assert.match(toolResults[0], /switched off/, 'a hidden tool cannot be forced either');
    chatCalls = 0;
    toolResults.length = 0;
    await run('ses_councilOn', 'Созови совет моделей: какая архитектура лучше?');
    assert.equal(toolNamesSeen.includes('council'), true);
    assert.equal(memberCalls, 6, 'two councils × three members; the third request is refused');
    assert.match(toolResults[0], /Council verdict: UNANIMOUS — option C/);
    assert.match(toolResults[2], /already convened 2 times/);
    store.setPrefs(owner, { appSettings: { value: { agentCouncil: true } } });
    chatCalls = 0;
    toolResults.length = 0;
    await run('ses_councilSetting', 'выбери архитектуру');
    assert.equal(toolNamesSeen.includes('council'), true, 'the setting alone enables it');
  } finally {
    providers.setProviderTransportForTests(null);
    agent.resetAgentStateForTests();
  }
});
