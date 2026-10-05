import assert from 'node:assert/strict';
import test from 'node:test';
import { demoteDraftTextToReasoning } from '../server/native/agent/message-parts.mjs';

function setup(parts) {
  const assistant = { id: 'm1', sessionID: 's1', parts: [...parts] };
  const events = [];
  let saved = 0;
  return {
    assistant,
    events,
    deps: { putMessage: () => { saved += 1; }, emit: (...args) => events.push(args) },
    saves: () => saved,
  };
}

test('superseded draft text becomes a reasoning part and is kept', () => {
  const draft = { id: 'p1', type: 'text', text: 'Черновик ответа' };
  const { assistant, events, deps, saves } = setup([draft]);
  assert.equal(demoteDraftTextToReasoning(assistant, [draft], deps), 1);
  assert.equal(draft.type, 'reasoning');
  assert.equal(draft.text, 'Черновик ответа');
  assert.equal(events.length, 1);
  assert.equal(saves(), 1);
});

test('empty, foreign and non-text parts are left alone', () => {
  const empty = { id: 'p1', type: 'text', text: '  ' };
  const reasoning = { id: 'p2', type: 'reasoning', text: 'мысли' };
  const foreign = { id: 'p3', type: 'text', text: 'other step' };
  const { assistant, events, deps, saves } = setup([empty, reasoning]);
  assert.equal(demoteDraftTextToReasoning(assistant, [empty, reasoning, foreign], deps), 0);
  assert.equal(empty.type, 'text');
  assert.equal(foreign.type, 'text');
  assert.equal(events.length, 0);
  assert.equal(saves(), 0);
});
