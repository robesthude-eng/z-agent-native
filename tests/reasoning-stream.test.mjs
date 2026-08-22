import assert from 'node:assert/strict';
import test from 'node:test';
import { createReasoningSplitter } from '../server/native/reasoning-stream.mjs';

// Лента кладёт отрезки в части: смена рода = новая часть (новая карточка).
// Здесь та же сборка, что в liveTextSink, только без стора и событий.
function collect(chunks) {
  const segments = [];
  const parts = [];
  const splitter = createReasoningSplitter((segment) => {
    segments.push(segment);
    const last = parts[parts.length - 1];
    if (!last || last.type !== segment.kind) parts.push({ type: segment.kind, text: segment.text });
    else if (segment.replace) last.text = segment.text;
    else last.text += segment.text;
  });
  for (const chunk of chunks) {
    if (Array.isArray(chunk)) splitter.push(chunk[0], chunk[1]);
    else splitter.push(chunk, null);
  }
  splitter.flush();
  return { segments, parts, ...splitter.snapshot() };
}

test('помеченные провайдером мысли не попадают в ответ', () => {
  const out = collect([['Need to open the file. ', 'reasoning'], ['Готово.', 'text']]);
  assert.deepEqual(out.parts.map((p) => p.type), ['reasoning', 'text']);
  assert.equal(out.text, 'Готово.');
  assert.equal(out.reasoning, 'Need to open the file. ');
});

test('каждая новая вспышка рассуждений — отдельная карточка', () => {
  const out = collect([
    ['First I check the config.', 'reasoning'],
    ['Смотрю конфиг.', 'text'],
    ['Now the second thought.', 'reasoning'],
    ['Правка готова.', 'text'],
  ]);
  assert.deepEqual(out.parts.map((p) => p.type), ['reasoning', 'text', 'reasoning', 'text']);
  assert.equal(out.parts[2].text, 'Now the second thought.');
  assert.equal(out.text, 'Смотрю конфиг.Правка готова.');
});

test('тег think, разрезанный между чанками', () => {
  const out = collect([
    ['<thi', 'text'],
    ['nk>Let me read the file', 'text'],
    [' first.</thi', 'text'],
    ['nk>Файл прочитан.', 'text'],
  ]);
  assert.deepEqual(out.parts.map((p) => p.type), ['reasoning', 'text']);
  assert.equal(out.parts[0].text, 'Let me read the file first.');
  assert.equal(out.text, 'Файл прочитан.');
  assert.ok(!out.text.includes('<think>'));
});

test('варианты тегов thinking/thought/reasoning', () => {
  for (const tag of ['thinking', 'thought', 'reasoning']) {
    const out = collect([[`<${tag}>inner monologue</${tag}>Ответ готов.`, 'text']]);
    assert.deepEqual(out.parts.map((p) => p.type), ['reasoning', 'text'], tag);
    assert.equal(out.reasoning, 'inner monologue', tag);
    assert.equal(out.text, 'Ответ готов.', tag);
  }
});

test('текст с угловой скобкой не теряется', () => {
  const out = collect([['const ok = a <', 'text'], [' b;', 'text']]);
  assert.deepEqual(out.parts.map((p) => p.type), ['text']);
  assert.equal(out.text, 'const ok = a < b;');
});

test('непомеченный английский монолог уезжает в карточку', () => {
  const out = collect(['The user asks about the card. ', 'I should answer in Russian. ', 'Привет! Всё готово.']);
  assert.deepEqual(out.parts.map((p) => p.type), ['reasoning', 'text']);
  assert.ok(out.parts[0].text.startsWith('The user asks'));
  assert.ok(out.text.startsWith('Привет!'));
  assert.ok(!out.parts[0].text.includes('Привет'));
});

test('непомеченный русский ответ никогда не становится карточкой', () => {
  const out = collect(['Привет! ', 'Сейчас проверю проект и отвечу.']);
  assert.deepEqual(out.parts.map((p) => p.type), ['text']);
  assert.equal(out.reasoning, '');
});

test('flush отдаёт придержанный хвост и незакрытый тег', () => {
  const unclosed = collect([['<think>thinking without the closing tag', 'text']]);
  assert.deepEqual(unclosed.parts.map((p) => p.type), ['reasoning']);
  assert.equal(unclosed.text, '');

  const dangling = collect([['Ответ готов <', 'text']]);
  assert.equal(dangling.text, 'Ответ готов <');
});
