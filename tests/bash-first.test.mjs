import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-bash-first-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';

const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const providers = await import('../server/native/providers.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');
const options = await import('../server/native/chat-tool-options.mjs');
const { systemPrompt } = await import('../server/native/agent-frames.mjs');
const { availableToolDefinitions } = await import('../server/native/tools.mjs');
const context = await import('../server/native/context.mjs');

const ownerId = 'bash-first@example.com';
const providerId = 'openai';
store.createUser(ownerId, 'hash');
providerConfigs.upsertProviderConfig(ownerId, { id: providerId, name: 'Bash First OpenAI', protocol: 'openai', baseURL: 'https://1.1.1.1/v1', enabled: true });
store.setProviderKey(ownerId, providerId, 'sk-bash-first');
providers.setProviderTransportForTests((url, init) => globalThis.fetch(url, init));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const names = (defs) => defs.map((t) => t.name);

test('toolOptions: bashFirst defaults to off and must be a boolean', () => {
  assert.deepEqual(options.normalizeChatToolOptions(undefined), { webSearch: true });
  assert.deepEqual(options.normalizeChatToolOptions({ webSearch: false, bashFirst: false }), { webSearch: false });
  assert.deepEqual(options.normalizeChatToolOptions({ bashFirst: true }), { webSearch: true, bashFirst: true });
  assert.throws(() => options.normalizeChatToolOptions({ bashFirst: 'yes' }), /bashFirst must be a boolean/);
  assert.throws(() => options.normalizeChatToolOptions({ webSearch: 1 }), /webSearch must be a boolean/);
});

test('bash-first replaces exploration tools with bash and keeps the editing tools', () => {
  const all = availableToolDefinitions();
  assert.ok(names(all).includes('bash'));
  const tools = names(options.filterChatTools(all, { webSearch: true, bashFirst: true }));
  for (const gone of Object.keys(options.BASH_FIRST_REPLACED)) assert.ok(!tools.includes(gone), `${gone} should be hidden`);
  for (const kept of ['bash', 'write', 'edit', 'apply_patch', 'todowrite', 'question', 'task']) assert.ok(tools.includes(kept), `${kept} should stay`);
  assert.ok(tools.length < all.length);
  // off: nothing changes
  assert.deepEqual(names(options.filterChatTools(all, { webSearch: true, bashFirst: false })), names(all));
});

test('without a shell the structured tools stay even if bash-first was requested', () => {
  const noShell = availableToolDefinitions().filter((t) => t.name !== 'bash');
  const effective = options.effectiveToolOptions({ webSearch: true, bashFirst: true }, noShell);
  assert.equal(effective.bashFirst, false);
  assert.ok(names(options.filterChatTools(noShell, effective)).includes('read'));
});

test('a hidden tool call is refused with the shell equivalent', () => {
  assert.throws(() => options.assertChatToolAllowed('grep', { bashFirst: true }), /bash-first.*grep -rnI/s);
  assert.throws(() => options.assertChatToolAllowed('READ', { bashFirst: true }), /sed -n/);
  options.assertChatToolAllowed('read', { bashFirst: false });
  options.assertChatToolAllowed('bash', { bashFirst: true });
});

test('the bash-first prompt section is added only when asked for and bash exists', () => {
  const base = systemPrompt({ toolNames: ['bash', 'read'] });
  const on = systemPrompt({ toolNames: ['bash', 'write'], bashFirst: true });
  assert.ok(!base.includes('Bash-first mode'));
  assert.ok(on.includes('Bash-first mode'));
  assert.ok(on.endsWith(on.slice(on.indexOf('# Bash-first mode'))), 'the override comes last');
  assert.ok(!systemPrompt({ toolNames: ['read'], bashFirst: true }).includes('Bash-first mode'));
});

test('reading a changed file back with cat/sed counts as the readback', () => {
  const strategy = context.createTurnStrategy('goal');
  context.observeTool(strategy, { name: 'write', arguments: { path: 'app.js', content: 'x' } }, { isError: false, mutatedPaths: ['app.js'], content: 'ok' });
  assert.deepEqual(strategy.pendingReadbacks, ['app.js']);
  context.observeTool(strategy, { name: 'bash', arguments: { command: 'ls app.js' } }, { isError: false, content: 'app.js', metadata: { workspaceChanges: { complete: true, paths: [] } } });
  assert.deepEqual(strategy.pendingReadbacks, ['app.js'], 'listing a file is not reading it');
  context.observeTool(strategy, { name: 'bash', arguments: { command: "sed -n '1,40p' app.js" } }, { isError: false, content: 'x', metadata: { workspaceChanges: { complete: true, paths: [] } } });
  assert.deepEqual(strategy.pendingReadbacks, []);
});

function sse(items) {
  return new Response(items.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('a bash-first turn sends the reduced toolset and answers a hidden-tool call with a hint', async () => {
  agent.resetAgentStateForTests();
  const sid = 'ses_bashfirst1';
  store.createChat(sid, ownerId, 'Bash first');
  const original = globalThis.fetch;
  const sent = [];
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ tools: (body.tools || []).map((t) => t.function.name), system: body.messages[0].content, last: body.messages.at(-1) });
    call += 1;
    if (call === 1) {
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
      ]);
    }
    return sse([{ choices: [{ delta: { content: 'Понял, использую bash.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
  };
  try {
    const assistant = await agent.runTurn({ sessionId: sid, ownerId, parts: [{ type: 'text', text: 'Покажи a.txt' }], model: { providerID: providerId, modelID: 'gpt-test' }, system: '', toolOptions: { webSearch: true, bashFirst: true } });
    assert.ok(!sent[0].tools.includes('read') && !sent[0].tools.includes('grep'));
    assert.ok(sent[0].tools.includes('bash') && sent[0].tools.includes('write'));
    assert.ok(sent[0].system.includes('Bash-first mode'));
    const readPart = assistant.parts.find((p) => p.type === 'tool' && p.tool === 'read');
    assert.equal(readPart.state.status, 'error');
    assert.match(readPart.state.output, /Use bash instead: sed -n/);
    // the model got the hint back and answered
    assert.match(String(sent[1].last.content), /Use bash instead/);

    // same chat, option off: the full toolset is back
    call = 99;
    sent.length = 0;
    await agent.runTurn({ sessionId: sid, ownerId, parts: [{ type: 'text', text: 'ещё' }], model: { providerID: providerId, modelID: 'gpt-test' }, system: '', toolOptions: { webSearch: true, bashFirst: false } });
    assert.ok(sent[0].tools.includes('read') && sent[0].tools.includes('grep'));
    assert.ok(!sent[0].system.includes('Bash-first mode'));
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
});
