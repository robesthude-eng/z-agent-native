import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeBrowserAction } from '../server/native/tools/browser.mjs';
import { clipLine, createProgressLog, formatElapsed } from '../server/native/tools/progress.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('progress log: first line is immediate, bursts are batched, the last state is delivered', async () => {
  const seen = [];
  const log = createProgressLog((text) => seen.push(text), { intervalMs: 40 });
  log.step('one');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\[0 с\] one$/);
  log.step('two');
  log.step('three');
  assert.equal(seen.length, 1);
  await sleep(90);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].split('\n').length, 3);
  log.stop();
  log.step('after stop');
  await sleep(60);
  assert.equal(seen.length, 2);
});

test('progress log: ticker shows elapsed time and ends with the final text', async () => {
  const seen = [];
  const log = createProgressLog((text) => seen.push(text), { intervalMs: 5 });
  const done = log.ticker('Работаю', { everyMs: 20 });
  await sleep(90);
  assert.ok(seen.some((t) => /Работаю · \d+ с/.test(t)));
  done('Готово');
  await sleep(20);
  assert.match(seen.at(-1), /Готово$/);
  const count = seen.length;
  await sleep(60);
  assert.equal(seen.length, count, 'the ticker stops with the step');
  log.stop();
});

test('progress log keeps the newest lines when it grows past the card limit', () => {
  const seen = [];
  const log = createProgressLog((text) => seen.push(text), { intervalMs: 0 });
  for (let i = 0; i < 200; i++) log.step(`line number ${i} ${'x'.repeat(60)}`);
  const last = seen.at(-1);
  assert.ok(last.length <= 4100);
  assert.match(last, /line number 199/);
  assert.match(last, /ранние шаги скрыты/);
  log.stop();
});

test('progress log without a consumer is inert', () => {
  const log = createProgressLog(undefined);
  log.step('x');
  log.ticker('y')('z');
  log.stop();
  assert.equal(log.text(), '');
});

test('formatting helpers', () => {
  assert.equal(formatElapsed(0), '0 с');
  assert.equal(formatElapsed(59_900), '59 с');
  assert.equal(formatElapsed(125_000), '2 м 05 с');
  assert.equal(clipLine('a\n  b   c'), 'a b c');
  assert.equal(clipLine('x'.repeat(300), 10).length, 10);
});

test('browser actions are described in plain words', () => {
  assert.match(describeBrowserAction('open', { url: 'https://example.com' }), /Открываю https:\/\/example\.com/);
  assert.match(describeBrowserAction('click', { selector: '#go' }), /#go/);
  assert.match(describeBrowserAction('screenshot', { width: 390 }), /390px/);
  assert.match(describeBrowserAction('whatever', {}), /whatever/);
});

test('background wait streams a live tail of the job log with a heartbeat header', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-bgwait-'));
  const id = 'job_livewait1';
  const dir = path.join(root, '.agent-home', 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, name: 'build', command: 'make', startedAt: Date.now(), pid: 0 }));
  fs.writeFileSync(path.join(dir, 'output.log'), 'compiling a\n');
  const { executeBackgroundTool } = await import('../server/native/background-jobs.mjs');
  const shown = [];
  setTimeout(() => fs.appendFileSync(path.join(dir, 'output.log'), 'compiling b\n'), 700);
  setTimeout(() => fs.writeFileSync(path.join(dir, 'exit_code'), '0\n'), 1700);
  try {
    const result = await executeBackgroundTool(root, { action: 'wait', id, timeoutSec: 30 }, { onOutput: (text) => shown.push(text) });
    assert.match(result.output, /succeeded/);
    assert.ok(shown.length >= 3, `expected several live updates, got ${shown.length}`);
    assert.ok(shown.every((t) => t.startsWith('build: работает')));
    assert.ok(shown.some((t) => t.includes('compiling a') && !t.includes('compiling b')));
    assert.ok(
      shown.some((t) => t.includes('compiling b')),
      'new log lines show up while waiting',
    );
    assert.ok(new Set(shown).size === shown.length, 'identical frames are not re-sent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
