import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-quality-'));
fs.chmodSync(root, 0o755);
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const providers = await import('../server/native/providers.mjs');
const configs = await import('../server/native/provider-configs.mjs');
const { executeMemoryTool, executeSkillTool, memoryPrompt } = await import('../server/native/agent-memory.mjs');
const { parseReview, reviewablePaths, shouldReview } = await import('../server/native/agent/reviewer.mjs');
const dossier = await import('../server/native/agent/dossier.mjs');
const { framesFromMessages } = await import('../server/native/agent-frames.mjs');
const { buildModelPlan } = await import('../server/native/autopilot.mjs');
const bg = await import('../server/native/background-jobs.mjs');
const { agentFeatureFlags } = await import('../server/native/user-settings-prompt.mjs');

const owner = 'quality@example.com';
store.createUser(owner, 'hash');
configs.upsertProviderConfig(owner, { id: 'channel_q', name: 'Q', protocol: 'openai', baseURL: 'https://1.1.1.1/v1', enabled: true });
store.setProviderKey(owner, 'channel_q', 'k');
const MODEL = { providerID: 'channel_q', modelID: 'm' };
test.after(() => {
  providers.setProviderTransportForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function sse(delta, finish = 'stop') {
  return new Response(
    [{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]']
      .map((x) => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const plain = (content) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), {
    headers: { 'content-type': 'application/json' },
  });
const toolCall = (id, name, args) =>
  sse({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');

test('memory tool: add, dedupe, chat scope, prompt, remove', () => {
  store.createChat('ses_memA', owner, 'A');
  store.createChat('ses_memB', owner, 'B');
  const ctx = { ownerId: owner, sessionId: 'ses_memA' };
  const a = executeMemoryTool({ action: 'add', text: 'Сервер — Ubuntu 24.04', kind: 'fact' }, ctx);
  assert.match(a.output, /Remembered \[mem_/);
  assert.match(executeMemoryTool({ action: 'add', text: 'сервер — ubuntu 24.04' }, ctx).output, /Already remembered/);
  executeMemoryTool({ action: 'add', text: 'В этом чате порт 8080', scope: 'chat' }, ctx);
  assert.match(memoryPrompt(owner, 'ses_memA'), /порт 8080/);
  assert.doesNotMatch(memoryPrompt(owner, 'ses_memB'), /порт 8080/);
  assert.match(memoryPrompt(owner, 'ses_memB'), /Ubuntu 24\.04/);
  const id = /\[(mem_[^\]]+)\]/.exec(a.output)[1];
  executeMemoryTool({ action: 'remove', id }, ctx);
  assert.doesNotMatch(memoryPrompt(owner, 'ses_memB'), /Сервер — Ubuntu/);
  store.clearChatMemory('ses_memA');
  assert.doesNotMatch(memoryPrompt(owner, 'ses_memA'), /порт 8080/);
});

test('skill tool: save, update by name, read counts use, index in prompt', () => {
  const ctx = { ownerId: owner };
  assert.match(
    executeSkillTool({ action: 'save', name: 'Deploy RUVDS', description: 'деплой на сервер', content: '1. ./run.sh' }, ctx).output,
    /Saved new skill "deploy-ruvds"/,
  );
  assert.match(
    executeSkillTool(
      { action: 'save', name: 'deploy-ruvds', description: 'деплой на сервер', content: '1. ./run.sh\n2. проверить /health' },
      ctx,
    ).output,
    /Updated/,
  );
  assert.match(executeSkillTool({ action: 'read', name: 'deploy-ruvds' }, ctx).output, /проверить \/health/);
  assert.equal(store.listSkills(owner)[0].uses, 1);
  assert.match(memoryPrompt(owner, null), /deploy-ruvds — деплой на сервер/);
  assert.throws(() => executeSkillTool({ action: 'read', name: 'nope' }, ctx), /not found/);
});

test('feature flags default to on and respect settings', () => {
  assert.deepEqual(agentFeatureFlags({}), {
    review: true,
    visualCheck: true,
    autoResume: true,
    dossier: true,
    memory: true,
    instincts: true,
  });
  assert.equal(agentFeatureFlags({ agentReview: false }).review, false);
});

test('reviewer: parse verdicts and pick reviewable paths', () => {
  assert.equal(
    parseReview('```json\n{"verdict":"fix","issues":[{"severity":"major","file":"a.js","problem":"bug","fix":"x"}]}\n```').verdict,
    'fix',
  );
  assert.equal(parseReview('{"verdict":"fix","issues":[{"severity":"minor","problem":"nit"}]}').verdict, 'pass');
  assert.equal(parseReview('no json'), null);
  assert.deepEqual(reviewablePaths({ changedPaths: ['.', '.screenshots/a.png', 'src/a.ts', 'logo.png', 'src/a.ts'] }), ['src/a.ts']);
  assert.equal(shouldReview({ changed: true, changedPaths: ['a.js'] }, { reviewsDone: 1 }), false);
  assert.equal(shouldReview({ changed: true, changedPaths: ['a.js'] }, {}), true);
});

test('turn: reviewer finds an issue, agent fixes it before the final answer', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_review1';
  store.createChat(sid, owner, 'R');
  let main = 0;
  let reviews = 0;
  const seen = [];
  providers.setProviderTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body);
    const sys = String(body.messages[0]?.content || '');
    if (sys.includes('strict senior code reviewer')) {
      reviews += 1;
      return plain(
        JSON.stringify({
          verdict: 'fix',
          summary: 'опечатка',
          issues: [{ severity: 'major', file: 'notes.md', line: 1, problem: 'Опечатка в заголовке', fix: 'Заменить Helo на Hello' }],
        }),
      );
    }
    main += 1;
    seen.push(String(body.messages.at(-1)?.content || ''));
    if (main === 1) return toolCall('w1', 'write', { path: 'notes.md', content: '# Helo\n' });
    if (main === 2) return toolCall('r1', 'read', { path: 'notes.md' });
    if (main === 3) return sse({ content: 'Готово: создал notes.md.' });
    if (main === 4) return toolCall('e1', 'edit', { path: 'notes.md', oldText: 'Helo', newText: 'Hello' });
    if (main === 5) return toolCall('r2', 'read', { path: 'notes.md' });
    return sse({ content: 'Готово: notes.md с заголовком Hello (исправлено после ревью).' });
  });
  const assistant = await agent.runTurn({
    sessionId: sid,
    ownerId: owner,
    parts: [{ type: 'text', text: 'Создай notes.md с заголовком Hello' }],
    model: MODEL,
    system: '',
  });
  assert.equal(reviews, 1, 'exactly one review per turn');
  assert.ok(seen[3].includes('[Runtime review]') && seen[3].includes('Опечатка'), 'issues are fed back to the agent');
  assert.equal(fs.readFileSync(path.join(store.workspaceFor(sid), 'notes.md'), 'utf8'), '# Hello\n');
  const reviewPart = assistant.parts.find((p) => p.type === 'tool' && p.tool === 'review');
  assert.equal(reviewPart?.state?.status, 'completed');
  assert.match(reviewPart.state.title, /найдено проблем — 1/);
  // review-карточка не попадает в историю модели следующего хода
  assert.ok(
    !framesFromMessages(store.listMessages(sid), store.workspaceFor(sid)).some(
      (f) => f.name === 'review' || (f.toolCalls || []).some((c) => c.name === 'review'),
    ),
  );
});

test('turn: changed UI files trigger one visual-check nudge', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_visual1';
  store.createChat(sid, owner, 'V');
  store.setPrefs(owner, { appSettings: { value: { agentReview: false } } });
  let main = 0;
  const seen = [];
  providers.setProviderTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body);
    main += 1;
    seen.push(String(body.messages.at(-1)?.content || ''));
    if (main === 1) return toolCall('w1', 'write', { path: 'index.html', content: '<h1>Hi</h1>' });
    if (main === 2) return toolCall('r1', 'read', { path: 'index.html' });
    return sse({ content: 'Страница готова.' });
  });
  try {
    await agent.runTurn({ sessionId: sid, ownerId: owner, parts: [{ type: 'text', text: 'Сделай страницу' }], model: MODEL, system: '' });
  } finally {
    store.setPrefs(owner, {});
  }
  const tools = (await import('../server/native/tools.mjs')).availableToolDefinitions().map((t) => t.name);
  if (tools.includes('visual_check')) {
    assert.ok(
      seen.some((s) => s.includes('[Runtime visual check]')),
      'agent is asked to look at the UI',
    );
    assert.equal(seen.filter((s) => s.includes('[Runtime visual check]')).length, 1, 'nudged only once');
  }
});

test('dossier: long history is condensed, recent messages kept verbatim', async () => {
  const sid = 'ses_dossier1';
  store.createChat(sid, owner, 'D');
  const big = (tag) => `${tag} ${'x'.repeat(60_000)}`;
  const history = [];
  for (let i = 0; i < 4; i++) {
    history.push({ id: `msg_u${i}`, role: 'user', parts: [{ type: 'text', text: big(`вопрос ${i}`) }] });
    history.push({ id: `msg_a${i}`, role: 'assistant', parts: [{ type: 'text', text: big(`ответ ${i}`) }] });
  }
  let summarized = '';
  providers.setProviderTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body);
    summarized = String(body.messages.at(-1)?.content || '');
    return plain(`## Цель и контекст\n${'Пользователь строит проект. '.repeat(20)}`);
  });
  const workspace = store.workspaceFor(sid);
  const framesFor = (m) => framesFromMessages(m, workspace);
  const plan = await buildModelPlan(owner, MODEL);
  const frames = await dossier.framesWithDossier({ sessionId: sid, ownerId: owner, modelPlan: plan, history, framesFor, enabled: true });
  assert.ok(summarized.includes('вопрос 0'), 'oldest messages are summarized');
  assert.ok(frames[0].role === 'user' && frames[0].content.startsWith('[Runtime: task dossier]'));
  assert.ok(
    frames.some((f) => String(f.content).startsWith('ответ 3')),
    'latest messages stay verbatim',
  );
  assert.ok(!frames.some((f) => String(f.content).startsWith('ответ 0')), 'oldest messages are not sent verbatim');
  const saved = dossier.readDossier(sid);
  assert.ok(saved?.uptoMessageId);
  // повторный ход без новой истории не пересказывает заново
  summarized = '';
  await dossier.framesWithDossier({ sessionId: sid, ownerId: owner, modelPlan: plan, history, framesFor, enabled: true });
  assert.equal(summarized, '');
  dossier.clearDossier(sid);
  assert.equal(dossier.readDossier(sid), null);
});

test('background job: start, wait, status and auto-resume notification', async () => {
  const sid = 'ses_bg1';
  store.createChat(sid, owner, 'B');
  const ws = store.workspaceFor(sid);
  const ctx = { sessionId: sid, ownerId: owner };
  const started = await bg.executeBackgroundTool(ws, { action: 'start', command: 'sleep 1; echo build-ok', name: 'build' }, ctx);
  const id = started.metadata.background.id;
  assert.match(started.output, /Started background job job_/);
  const done = await bg.executeBackgroundTool(ws, { action: 'wait', id, timeoutSec: 20 }, ctx);
  assert.match(done.output, /succeeded \(exit 0\)/);
  assert.match(done.output, /build-ok/);
  assert.match((await bg.executeBackgroundTool(ws, { action: 'list' }, ctx)).output, /build/);

  // задача закончилась после ответа агента -> чат продолжается сам
  const submitted = [];
  bg.configureBackgroundJobHooks({
    isTurnActive: () => false,
    submit: async (x) => {
      submitted.push(x);
    },
  });
  const second = await bg.executeBackgroundTool(ws, { action: 'start', command: 'echo trained; exit 3', name: 'train' }, ctx);
  await new Promise((r) => setTimeout(r, 1500));
  await bg.backgroundJobsTickForTests();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].sessionId, sid);
  assert.match(submitted[0].text, /«train» завершилась с ошибкой \(код 3\)/);
  assert.match(submitted[0].text, /trained/);
  await bg.backgroundJobsTickForTests();
  assert.equal(submitted.length, 1, 'notified only once');
  assert.ok(second.metadata.background.id);
  await assert.rejects(bg.executeBackgroundTool(ws, { action: 'status', id: '../../etc' }, ctx), /Unknown background job id/);
  // подложенная агентом ссылка на чужой файл не читается сервером
  const jobLog = path.join(ws, '.agent-home/jobs', id, 'output.log');
  fs.rmSync(jobLog);
  fs.symlinkSync('/etc/passwd', jobLog);
  const leaked = await bg.executeBackgroundTool(ws, { action: 'logs', id }, ctx);
  assert.doesNotMatch(leaked.output, /root:/);
});
