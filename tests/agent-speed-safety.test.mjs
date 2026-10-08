import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-safety-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const { isParallelSafe, planBatches, runBatch, PARALLEL_LIMIT } = await import('../server/native/agent/parallel.mjs');
const fa = await import('../server/native/agent/file-awareness.mjs');
const { withAnthropicCache } = await import('../server/native/providers/streaming.mjs');
const { foldSystemTail } = await import('../server/native/providers/caller.mjs');
const { createTurnStrategy, observeTool } = await import('../server/native/context.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const call = (name, args = {}) => ({ id: `${name}_${Math.random()}`, name, arguments: args });

test('only pure reads and read-only subagents run in parallel', () => {
  for (const n of ['read', 'list', 'glob', 'grep', 'repo_map', 'webfetch', 'websearch']) assert.equal(isParallelSafe(call(n)), true, n);
  for (const n of ['write', 'edit', 'apply_patch', 'bash', 'git', 'run_tests', 'question', 'todowrite', 'memory', 'skill', 'browser'])
    assert.equal(isParallelSafe(call(n)), false, n);
  assert.equal(isParallelSafe(call('task', { agent: 'explore' })), true);
  assert.equal(isParallelSafe(call('task', { agent: 'review' })), true);
  assert.equal(isParallelSafe(call('task', { agent: 'implement' })), false);
});

test('batches keep the model order, group neighbouring reads and isolate every mutation', () => {
  const calls = [call('read'), call('grep'), call('edit'), call('read'), call('read'), call('bash'), call('read')];
  const batches = planBatches(calls);
  assert.deepEqual(
    batches.map((b) => b.map((c) => c.name)),
    [['read', 'grep'], ['edit'], ['read', 'read'], ['bash'], ['read']],
  );
  assert.deepEqual(batches.flat(), calls);
  const many = Array.from({ length: PARALLEL_LIMIT * 2 + 1 }, () => call('read'));
  assert.deepEqual(
    planBatches(many).map((b) => b.length),
    [PARALLEL_LIMIT, PARALLEL_LIMIT, 1],
  );
});

test('a batch really runs concurrently and returns results in call order', async () => {
  let running = 0;
  let peak = 0;
  const calls = [call('read'), call('read'), call('read')];
  const delays = [30, 5, 15];
  const results = await runBatch(calls, async (_c, i) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, delays[i]));
    running--;
    return i;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, [0, 1, 2]);
  const started = Date.now();
  await runBatch(calls, () => new Promise((r) => setTimeout(r, 40)));
  assert.ok(Date.now() - started < 100, 'three 40 ms calls must overlap');
});

test('a failing call waits for the others and rethrows; cancellation wins', async () => {
  const done = [];
  const calls = [call('read'), call('read'), call('read')];
  await assert.rejects(
    runBatch(calls, async (_c, i) => {
      await new Promise((r) => setTimeout(r, 5 * (i + 1)));
      done.push(i);
      if (i === 0) throw new Error('boom');
      if (i === 2) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return i;
    }),
    /aborted/,
  );
  assert.deepEqual(done, [0, 1, 2]);
  assert.deepEqual(await runBatch([call('read')], async () => 'single'), ['single']);
});

test('write over an unseen existing file is refused once with a preview; the identical retry goes through', () => {
  fa.resetFileAwarenessForTests();
  const ws = path.join(root, 'ws1');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src/app.js'), 'const important = 1;\nexport default important;\n');
  fs.writeFileSync(path.join(ws, 'empty.txt'), '');
  const write = (p, content = 'new') => call('write', { path: p, content });
  const msg = fa.overwriteGate('s1', ws, write('src/app.js'));
  assert.match(msg, /already exists/);
  assert.match(msg, /const important = 1;/);
  assert.match(msg, /send the same write call again/);
  assert.equal(fa.overwriteGate('s1', ws, write('src/app.js')), null, 'identical retry is a deliberate overwrite');
  assert.match(
    fa.overwriteGate('s1', ws, write('src/app.js', 'different content')),
    /already exists/,
    'a different payload is gated again',
  );
  assert.equal(fa.overwriteGate('s1', ws, write('src/new.js')), null, 'new files are free');
  assert.equal(fa.overwriteGate('s1', ws, write('empty.txt')), null, 'empty files carry nothing to lose');
  assert.equal(fa.overwriteGate('s1', ws, call('edit', { path: 'src/app.js' })), null, 'only write is gated');
  assert.equal(fa.overwriteGate('s1', ws, write('../outside.txt')), null, 'invalid paths are left to the tool');
});

test('reading, creating, editing or cat-ing a file counts as having seen it; sessions are independent', () => {
  fa.resetFileAwarenessForTests();
  const ws = path.join(root, 'ws2');
  fs.mkdirSync(ws, { recursive: true });
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) fs.writeFileSync(path.join(ws, f), `${f} content`);
  const write = (p) => call('write', { path: p, content: 'x' });
  fa.observeFileTool('s2', call('read', { path: './a.txt' }), { isError: false });
  fa.observeFileTool('s2', call('write', { path: 'b.txt' }), { isError: false, mutatedPaths: ['b.txt'] });
  fa.observeFileTool('s2', call('bash', { command: 'sed -n 1,20p c.txt' }), { isError: false });
  for (const f of ['a.txt', 'b.txt', 'c.txt']) assert.equal(fa.overwriteGate('s2', ws, write(f)), null, f);
  assert.ok(fa.overwriteGate('s2', ws, write('d.txt')));
  assert.ok(fa.overwriteGate('other-session', ws, write('a.txt')), 'awareness is per chat');
  fa.observeFileTool('s2', call('read', { path: 'd.txt' }), { isError: true });
  fa.clearFileAwareness('s2');
  assert.ok(fa.overwriteGate('s2', ws, write('a.txt')), 'cleared with the chat');
});

test('a runtime gate refusal is guidance: not a tool error, not a change', () => {
  const strategy = createTurnStrategy('перепиши файл');
  observeTool(strategy, call('write', { path: 'a.txt', content: 'x' }), { isError: true, metadata: { runtimeGate: 'overwrite-unread' } });
  assert.equal(strategy.toolErrors, 0);
  assert.equal(strategy.changed, false);
  observeTool(strategy, call('read', { path: 'zzz' }), { isError: true });
  assert.equal(strategy.toolErrors, 1);
});

test('Anthropic prompt cache: marks system, last tool and last message block only for api.anthropic.com', () => {
  const req = {
    model: 'm',
    system: 'SYSTEM',
    tools: [{ name: 'a' }, { name: 'b' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    ],
  };
  const cached = withAnthropicCache(req, 'https://api.anthropic.com/v1', 'TAIL');
  assert.deepEqual(cached.system, [
    { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'TAIL' },
  ]);
  assert.equal(cached.tools[0].cache_control, undefined);
  assert.deepEqual(cached.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(cached.messages[1].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(cached.messages[0].content[0].cache_control, undefined);
  assert.equal(req.system, 'SYSTEM', 'input is not mutated');
  assert.equal(req.messages[1].content[0].cache_control, undefined);
  const other = withAnthropicCache(req, 'https://gateway.example.com/v1', 'TAIL');
  assert.equal(other.system, 'SYSTEM\n\nTAIL');
  assert.equal(JSON.stringify(other).includes('cache_control'), false);
  assert.equal(withAnthropicCache(req, 'not a url').system, 'SYSTEM');
  const emptyTail = withAnthropicCache(
    { ...req, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't' }] }] },
    'https://api.anthropic.com/v1',
  );
  assert.equal(JSON.stringify(emptyTail.messages).includes('cache_control'), false, 'thinking blocks cannot be cache breakpoints');
});

test('the volatile system tail is folded into system for providers without prompt caching', () => {
  const req = { system: 'STABLE', systemTail: 'VOLATILE', frames: [] };
  const folded = foldSystemTail({ spec: { kind: 'openai' } }, req);
  assert.equal(folded.system, 'STABLE\n\nVOLATILE');
  assert.equal('systemTail' in folded, false);
  assert.equal(foldSystemTail({ spec: { kind: 'anthropic' } }, req), req, 'Anthropic gets the split form');
  assert.equal(foldSystemTail({ spec: { kind: 'google' } }, { system: 'S', frames: [] }).system, 'S');
});

test('the real agent loop runs reads in parallel, keeps result order and gates a blind overwrite', async () => {
  const store = await import('../server/native/store.mjs');
  const agent = await import('../server/native/agent.mjs');
  const providers = await import('../server/native/providers.mjs');
  const configs = await import('../server/native/provider-configs.mjs');
  const owner = 'speed-owner@example.com';
  store.createUser(owner, 'hash');
  configs.upsertProviderConfig(owner, {
    id: 'channel_speed',
    name: 'Speed test',
    protocol: 'openai',
    baseURL: 'https://1.1.1.1/v1',
    enabled: true,
  });
  store.setProviderKey(owner, 'channel_speed', 'dummy-test-key');
  agent.resetAgentStateForTests();
  const sid = 'ses_speedE2E';
  store.createChat(sid, owner, 'Speed');
  const ws = store.workspaceFor(sid);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'AAA');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'BBB');
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'precious notes');
  const sse = (delta, finish = 'stop') =>
    new Response(
      [{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]']
        .map((x) => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const toolCalls = (...items) =>
    sse(
      {
        tool_calls: items.map(([name, args], index) => ({
          index,
          id: `${name}${index}_${calls}`,
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
      'tool_calls',
    );
  let calls = 0;
  const seen = [];
  providers.setProviderTransportForTests(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const tools = body.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    seen.push(tools);
    if (calls === 1) return toolCalls(['read', { path: 'a.txt' }], ['read', { path: 'b.txt' }]);
    if (calls === 2) return toolCalls(['write', { path: 'notes.txt', content: 'replaced' }]);
    if (calls === 3) return toolCalls(['write', { path: 'notes.txt', content: 'replaced' }]);
    if (calls === 4) return toolCalls(['read', { path: 'notes.txt' }]);
    return sse({ content: 'Готово: файл перезаписан осознанно.' });
  });
  try {
    await agent.runTurn({
      sessionId: sid,
      ownerId: owner,
      parts: [{ type: 'text', text: 'Прочитай a.txt и b.txt, затем перепиши notes.txt' }],
      model: { providerID: 'channel_speed', modelID: 'm' },
      system: '',
    });
    assert.ok(calls >= 5);
    const afterReads = seen[1];
    assert.ok(afterReads[0].includes('AAA') && afterReads[1].includes('BBB'), 'tool results keep the order of the calls');
    assert.match(seen[2].at(-1), /Not written: notes\.txt already exists/);
    assert.match(seen[2].at(-1), /precious notes/);
    assert.match(seen[3].at(-1), /Overwrote notes\.txt/);
    assert.equal(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8'), 'replaced');
  } finally {
    providers.setProviderTransportForTests(null);
    agent.resetAgentStateForTests();
  }
});
