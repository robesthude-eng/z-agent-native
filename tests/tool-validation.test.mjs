import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { expectsUserReply } from '../server/native/agent/turn-loop.mjs';
import { systemPrompt } from '../server/native/agent-frames.mjs';
import { validateToolInput } from '../server/native/tools/validate.mjs';
import { assertValidToolInput, executeTool } from '../server/native/tools.mjs';

test('write without required content is rejected before touching the file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-validate-'));
  try {
    await fs.writeFile(path.join(root, 'keep.txt'), '16 bytes of data');
    await assert.rejects(
      () => executeTool('write', { path: 'keep.txt' }, { workspace: root }),
      (err) => {
        assert.equal(err.code, 'INVALID_TOOL_ARGUMENTS');
        assert.match(err.message, /content: required/);
        assert.match(err.message, /Nothing was executed/);
        return true;
      },
    );
    assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), '16 bytes of data');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validation checks types, enums and nested items and coerces harmless string forms', () => {
  assert.deepEqual(assertValidToolInput('read', { path: 'a', offset: '5' }), { path: 'a', offset: 5 });
  assert.throws(
    () => assertValidToolInput('todowrite', { todos: [{ content: 'x', status: 'doing' }] }),
    /todos\[0\]\.status: must be one of/,
  );
  assert.throws(() => assertValidToolInput('edit', { path: 'a', oldText: 1, newText: 'b' }), /oldText: expected string/);
  assert.throws(() => assertValidToolInput('task', {}), /prompt: required/);
  const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 } }, required: [] };
  assert.equal(validateToolInput(schema, { n: 9 }).ok, false);
  assert.equal(validateToolInput(schema, { extra: true }).ok, true, 'unknown fields are tolerated');
});

test('a reply ending with a question to the user is a stopping point', () => {
  assert.equal(expectsUserReply('Готово.\n\nКакой вариант выбрать?'), true);
  assert.equal(expectsUserReply('Done.\n\nWould you like me to deploy it?'), true);
  assert.equal(expectsUserReply('Скажите, что делаем — и я начну.'), true);
  assert.equal(expectsUserReply('Всё сделано.'), false);
});

test('system prompt includes SSH and toolchain sections only when applicable', () => {
  const base = systemPrompt({ toolNames: ['read', 'bash'], goal: 'поправь README' });
  assert.doesNotMatch(base, /ssh_tool action=exec/);
  assert.doesNotMatch(base, /Toolchain specifics/);
  assert.doesNotMatch(base, /always available/);
  assert.doesNotMatch(base, /<think>/);
  assert.match(base, /When to stop/);
  const withSsh = systemPrompt({ toolNames: ['ssh_tool', 'ensure_environment'], goal: 'собери APK для Android' });
  assert.match(withSsh, /ssh_tool action=exec/);
  assert.match(withSsh, /Toolchain specifics/);
});

test('browser calls are normalized: aliases, value from text, screenshot allowed, unsupported rejected', () => {
  assert.deepEqual(assertValidToolInput('browser', { action: 'fill', selector: '#e', text: 'abc' }), {
    action: 'fill',
    selector: '#e',
    value: 'abc',
  });
  assert.equal(assertValidToolInput('browser', { action: 'key', key: 'Enter' }).action, 'press');
  assert.equal(assertValidToolInput('browser', { action: 'content' }).action, 'snapshot');
  assert.equal(assertValidToolInput('browser', { action: 'screenshot', width: 390 }).action, 'screenshot');
  assert.throws(() => assertValidToolInput('browser', { action: 'evaluate', script: '1' }), /must be one of/);
});

test('response instructions keep readable answers grounded in actual tool evidence', () => {
  const prompt = systemPrompt({ toolNames: ['read'], goal: 'объясни результат' });
  assert.match(prompt, /Readable user-facing responses/);
  assert.match(prompt, /Reply in the user's language/);
  assert.match(prompt, /Separate implementation from verification/);
  assert.match(prompt, /never invent test counts, file sizes, timings, URLs or successful execution/);
  assert.match(prompt, /a simple question needs a simple answer/);
});
