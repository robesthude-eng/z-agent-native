import assert from 'node:assert/strict';
import test from 'node:test';
import { isContextOverflowError } from '../server/native/agent/turn-loop.mjs';
import { compactFrames, contextWeight } from '../server/native/context.mjs';
import { MEDIA_TOOL_NAMES } from '../server/native/media/definitions.mjs';

const img = `data:image/png;base64,${'A'.repeat(400_000)}`;

test('view_media is a registered media tool', () => {
  assert.ok(MEDIA_TOOL_NAMES.includes('view_media'));
});

test('an image costs a fixed weight, not its base64 length', () => {
  const frames = [{ role: 'user', content: 'look', media: [{ name: 'a.png', dataUrl: img }] }];
  assert.ok(contextWeight(frames) < 10_000);
});

test('only the latest runtime media frames keep their images', () => {
  const frames = [1, 2, 3].map((i) => ({
    role: 'user',
    content: `view ${i}`,
    media: [{ name: `${i}.png`, dataUrl: img }],
    runtimeMedia: true,
  }));
  const out = compactFrames(frames);
  assert.equal(out[0].media.length, 0);
  assert.equal(out[1].media.length, 1);
  assert.equal(out[2].media.length, 1);
});

test('context overflow errors are recognised', () => {
  assert.ok(isContextOverflowError(new Error('Prompt exceeds max length')));
  assert.ok(isContextOverflowError({ message: "This model's maximum context length is 128000 tokens", statusCode: 400 }));
  assert.ok(isContextOverflowError({ message: 'x', statusCode: 413 }));
  assert.ok(!isContextOverflowError({ message: 'rate limit', statusCode: 429 }));
});
