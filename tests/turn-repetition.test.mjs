import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Регрессии из живого чата: итог печатался дважды (карточкой «мыслей» и
// ответом), а один и тот же адрес с редиректом запрашивался трижды подряд.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-repetition-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');

const store = await import('../server/native/store.mjs');
const agent = await import('../server/native/agent.mjs');
const providers = await import('../server/native/providers.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');
const { redirectRefusedError } = await import('../server/native/security.mjs');
const { createLoopGuard, observeToolLoop } = await import('../server/native/turn-trust.mjs');

const ownerId = 'repetition@example.com';
const providerId = 'openai';
store.createUser(ownerId, 'hash');
providerConfigs.upsertProviderConfig(ownerId, {
  id: providerId,
  name: 'Repetition Test OpenAI',
  protocol: 'openai',
  baseURL: 'https://1.1.1.1/v1',
  enabled: true,
});
store.setProviderKey(ownerId, providerId, 'sk-repetition-test');
providers.setProviderTransportForTests((url, init) => globalThis.fetch(url, init));

const ANSWER = 'Готово. Установлены три скила:\n\n- brand-guidelines\n- find-skills\n- design-tokens';

function sse(events) {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function copiesOf(parts, text) {
  return parts.filter((p) => (p.type === 'text' || p.type === 'reasoning') && String(p.text || '').trim() === text).length;
}

async function runWith(sid, fetchImpl) {
  agent.resetAgentStateForTests();
  store.createChat(sid, ownerId, 'Новый чат');
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const assistant = await agent.runTurn({
      sessionId: sid,
      ownerId,
      parts: [{ type: 'text', text: 'Найди и установи популярные скилы' }],
      model: { providerID: providerId, modelID: 'gpt-test' },
      system: '',
    });
    return { assistant, stored: store.listMessages(sid).find((m) => m.role === 'assistant') };
  } finally {
    globalThis.fetch = original;
    agent.resetAgentStateForTests();
  }
}

test('a final answer streamed only as reasoning is shown once, as the reply', async () => {
  const { assistant, stored } = await runWith('ses_reasoningfinal1', async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true, 'no extra summary request is needed');
    return sse([
      { choices: [{ delta: { reasoning_content: ANSWER.slice(0, 20) } }] },
      { choices: [{ delta: { reasoning_content: ANSWER.slice(20) } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
  });
  for (const message of [assistant, stored]) {
    assert.equal(copiesOf(message.parts, ANSWER), 1, 'the answer must not be repeated');
    assert.equal(message.parts.filter((p) => p.type === 'text').at(-1)?.text, ANSWER);
    assert.equal(message.parts.some((p) => p.type === 'reasoning' && String(p.text || '').trim()), false);
  }
});

test('a reasoning-only final after tool work stays single when the summary request fails', async () => {
  let streamCalls = 0;
  let summaryCalls = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { assistant, stored } = await runWith('ses_reasoningfinal2', async (_url, init) => {
      const body = JSON.parse(init.body);
      if (!body.stream) {
        summaryCalls += 1;
        return new Response(JSON.stringify({ error: { message: 'Invalid assistant message' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      streamCalls += 1;
      if (streamCalls === 1) {
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_read', function: { name: 'read', arguments: JSON.stringify({ path: 'missing.txt' }) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ]);
      }
      return sse([
        { choices: [{ delta: { reasoning_content: ANSWER } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    });
    assert.equal(streamCalls, 2);
    assert.equal(summaryCalls, 1);
    for (const message of [assistant, stored]) {
      assert.equal(copiesOf(message.parts, ANSWER), 1, 'the answer must not be repeated');
      assert.equal(message.parts.filter((p) => p.type === 'text').at(-1)?.text, ANSWER);
    }
  } finally {
    console.warn = warn;
  }
});

test('a refused redirect names its absolute target so the agent can request it directly', () => {
  const base = new URL('https://skills.sh/anthropics');
  const absolute = redirectRefusedError(base, 308, 'https://www.skills.sh/anthropics');
  assert.equal(absolute.statusCode, 502);
  assert.equal(absolute.location, 'https://www.skills.sh/anthropics');
  assert.match(absolute.message, /HTTP 308 -> https:\/\/www\.skills\.sh\/anthropics/);
  assert.equal(redirectRefusedError(base, 301, '/new?x=1#top').location, 'https://skills.sh/new?x=1');
  assert.equal(redirectRefusedError(base, 302, 'https://user:secret@example.com/a').location, 'https://example.com/a');
  for (const header of [undefined, '', '   ', 'file:///etc/passwd', 'javascript:alert(1)']) {
    const err = redirectRefusedError(base, 307, header);
    assert.equal(err.location, undefined);
    assert.equal(err.message, 'Redirects are not followed (HTTP 307)');
  }
});

test('the loop guard sees one URL fetched with different size limits as the same action', () => {
  const failed = { isError: true, content: 'Error: Redirects are not followed (HTTP 308)' };
  const url = 'https://skills.sh/anthropics';
  const guard = createLoopGuard();
  assert.ok(!observeToolLoop(guard, { name: 'webfetch', arguments: { url, maxChars: 12000 } }, failed));
  assert.ok(!observeToolLoop(guard, { name: 'webfetch', arguments: { url, maxChars: 15000 } }, failed));
  const loop = observeToolLoop(guard, { name: 'webfetch', arguments: { url: `${url}#top`, maxChars: 20000 } }, failed);
  assert.ok(loop, 'the third fetch of the same page is reported');
  assert.equal(loop.tool, 'webfetch');

  const distinct = createLoopGuard();
  for (const page of ['https://a.example/', 'https://b.example/', 'https://c.example/']) {
    assert.ok(!observeToolLoop(distinct, { name: 'webfetch', arguments: { url: page, maxChars: 12000 } }, failed));
  }
});
