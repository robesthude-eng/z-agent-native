import assert from 'node:assert/strict';
import test from 'node:test';
import { endsWithDanglingIntent } from '../server/native/agent/turn-loop.mjs';

test('a reply ending on an announced next step is not a final answer', () => {
  assert.equal(endsWithDanglingIntent('Screenshot returned. Let me close the browser session now that I have what I need.'), true);
  assert.equal(endsWithDanglingIntent('Файл создан.\n\nСейчас запущу тесты.'), true);
  assert.equal(endsWithDanglingIntent('Тесты упали. Попробую исправить импорт.'), true);
  assert.equal(endsWithDanglingIntent("Next, I'll run the build."), true);
});

test('ordinary final answers are accepted', () => {
  assert.equal(endsWithDanglingIntent(''), false);
  assert.equal(endsWithDanglingIntent('Готово: все 12 тестов прошли, сервер отвечает на /tasks.'), false);
  assert.equal(endsWithDanglingIntent('The page shows a heading "Example Domain" and one paragraph.'), false);
  assert.equal(endsWithDanglingIntent('Если хотите, могу добавить авторизацию.'), false);
  assert.equal(endsWithDanglingIntent('Let me know if you want any changes.'), false);
});
