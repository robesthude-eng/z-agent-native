import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-completion-'));
fs.chmodSync(root, 0o755);
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const providers = await import('../server/native/providers.mjs');
const configs = await import('../server/native/provider-configs.mjs');
const events = await import('../server/native/events.mjs');
const { synthesizeTurnSummary, expectsUserReply, endsWithDanglingIntent } = await import('../server/native/agent/turn-loop.mjs');
const owner = 'completion@example.com';
store.createUser(owner, 'test-hash');
configs.upsertProviderConfig(owner, { id: 'channel_test', name: 'Test', protocol: 'openai', baseURL: 'https://1.1.1.1/v1', enabled: true });
store.setProviderKey(owner, 'channel_test', 'test-key');
test.after(() => {
  providers.setProviderTransportForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function response(delta, finish = 'stop') {
  return new Response(
    [{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]']
      .map((x) => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const screenshotFinal =
  'Вывод\n\nСреда готова, но воркспейс пуст.\n\nСкажите, что делаем: развернуть проект с нуля, разобрать репозиторий или подготовить сборку — и я начну.';

for (const [name, tool, args, final, status] of [
  ['environment inspection', 'bash', { command: 'command -v node; command -v python3; ls -la' }, screenshotFinal, 'needs_input'],
  [
    'ordinary read-only report',
    'bash',
    { command: 'command -v node' },
    'Осмотр закончен: Node доступен, файлов проекта пока нет.',
    'completed',
  ],
  [
    'stale read-only plan',
    'todowrite',
    { todos: [{ id: 'audit', content: 'Осмотреть среду', status: 'in_progress', priority: 'medium' }] },
    'Осмотр среды завершён. Файлов проекта пока нет.',
    'partial',
  ],
]) {
  test(`${name} settles once without tools after the final answer`, async () => {
    agent.resetAgentStateForTests();
    const sid = `ses_completion${tool}${status.replaceAll('_', '')}`;
    store.createChat(sid, owner, 'Test');
    let calls = 0;
    const statuses = [];
    const unsubscribe = events.subscribe(sid, (frame) => {
      if (frame.event?.type === 'session.status') statuses.push(frame.event.properties.status);
    });
    providers.setProviderTransportForTests(async () => {
      calls++;
      if (calls === 1)
        return response(
          { tool_calls: [{ index: 0, id: 'inspect', function: { name: tool, arguments: JSON.stringify(args) } }] },
          'tool_calls',
        );
      return response({ content: final });
    });
    try {
      const assistant = await agent.runTurn({
        sessionId: sid,
        ownerId: owner,
        parts: [{ type: 'text', text: 'Изучи среду и сделай вывод.' }],
        model: { providerID: 'channel_test', modelID: 'model' },
        system: '',
      });
      assert.equal(calls, 2, 'no continuation request after a final report');
      assert.equal(assistant.info.strategy.changed, false);
      assert.equal(assistant.info.outcome.status, status);
      const executed = assistant.parts.filter((p) => p.type === 'tool');
      assert.equal(executed.length, 1);
      assert.equal(executed[0].state.status, 'completed');
      assert.equal(agent.isTurnActive(sid), false);
      assert.equal(statuses.at(-1), 'idle');
    } finally {
      unsubscribe();
      agent.resetAgentStateForTests();
    }
  });
}

test('a request for user input is a stopping point, not dangling intent', () => {
  assert.equal(expectsUserReply(screenshotFinal), true);
  assert.equal(endsWithDanglingIntent(screenshotFinal), false);
  assert.equal(expectsUserReply('Файл создан.\n\nСейчас запущу тесты.'), false);
  assert.equal(endsWithDanglingIntent('Файл создан.\n\nСейчас запущу тесты.'), true);
  assert.equal(expectsUserReply('Если хотите, могу добавить тесты.'), false);
});

test('fallback reports never invent verification or success after cancellation', () => {
  for (const status of ['completed', 'cancelled', 'partial', 'failed', 'needs_input']) {
    const text = synthesizeTurnSummary({ strategy: {}, outcome: { status } });
    assert.doesNotMatch(text, /Система работает штатно|Все компоненты.*проверены|успешно завершена/);
    if (status === 'cancelled') assert.match(text, /остановлен пользователем/);
    if (status === 'partial') assert.match(text, /не полностью/);
  }
  assert.match(
    synthesizeTurnSummary({ strategy: { changedPaths: ['a.js'] }, outcome: { status: 'cancelled' } }),
    /Ход остановлен пользователем/,
  );
});
