import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { previewDocument, previewIsReady, rewritePreviewHtml } from '../server/native/preview-document.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'z-preview-'));
}

test('empty workspace has no preview', () => {
  const root = tmp();
  assert.equal(previewDocument(root), null);
  assert.equal(previewIsReady(root), false);
});

test('index.html wins over other html files', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'checkers.html'), '<html>шашки</html>');
  fs.writeFileSync(path.join(root, 'index.html'), '<html>index</html>');
  assert.equal(previewDocument(root), 'index.html');
  assert.equal(previewIsReady(root), true);
});

test('a single root html file is the preview when index.html is missing', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'checkers.html'), '<html>шашки</html>');
  assert.equal(previewDocument(root), 'checkers.html');
});

test('newest root html wins when several exist and there is no index.html', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'old.html'), '<html>old</html>');
  const older = path.join(root, 'old.html');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(older, past, past);
  fs.writeFileSync(path.join(root, 'game.html'), '<html>game</html>');
  assert.equal(previewDocument(root), 'game.html');
});

test('nested html and empty files are ignored', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'page.html'), '<html>nested</html>');
  fs.writeFileSync(path.join(root, 'empty.html'), '');
  assert.equal(previewDocument(root), null);
});

test('built SPA in dist/ at the root becomes the preview', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<html>built</html>');
  assert.equal(previewDocument(root), 'dist/index.html');
});

test('unpacked project with dist/ is found one level below the root', () => {
  const root = tmp();
  const project = path.join(root, 'z-agent-native-main');
  fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(project, 'dist', 'index.html'), '<html>rebuilt</html>');
  assert.equal(previewDocument(root), 'z-agent-native-main/dist/index.html');
  assert.equal(previewIsReady(root), true);
});

test('root index.html still wins over a built project below it', () => {
  const root = tmp();
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(project, 'dist', 'index.html'), '<html>proj</html>');
  fs.writeFileSync(path.join(root, 'index.html'), '<html>demo</html>');
  assert.equal(previewDocument(root), 'index.html');
});

test('the most recently rebuilt project wins when several exist', () => {
  const root = tmp();
  for (const name of ['a-proj', 'b-proj']) {
    const dir = path.join(root, name, 'dist');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `<html>${name}</html>`);
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(dir, 'index.html'), past, past);
  }
  const fresh = path.join(root, 'b-proj', 'dist', 'index.html');
  fs.utimesSync(fresh, new Date(), new Date());
  assert.equal(previewDocument(root), 'b-proj/dist/index.html');
});

test('unbuilt vite source index.html is not previewed (would be a white screen)', () => {
  // Распакованный архив Vite-проекта без сборки: index.html ссылается на
  // несобранный /src/main.tsx. Превью должно отказаться, а не показать белое.
  const root = tmp();
  const project = path.join(root, 'z-agent-native-main');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><html><body><script type="module" src="/src/main.tsx"></script></body></html>');
  assert.equal(previewDocument(root), null);
  // После сборки dist/index.html появляется — и превью переключается на него.
  fs.mkdirSync(path.join(project, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(project, 'dist', 'index.html'), '<!doctype html><html><body><script type="module" src="assets/index-abc.js"></script></body></html>');
  assert.equal(previewDocument(root), 'z-agent-native-main/dist/index.html');
});

test('absolute asset paths in preview html become relative', () => {
  const html = [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="/assets/index-D5tadxWz.css">',
    '<link rel="icon" href="/favicon.ico">',
    '</head><body>',
    '<script src="/assets/index-DTblUuFQ.js"></script>',
    '<img src="/images/hero.png" srcset="/images/hero@2x.png 2x">',
    '</body></html>',
  ].join('');
  const out = rewritePreviewHtml(html);
  assert.match(out, /href="assets\/index-D5tadxWz\.css"/);
  assert.match(out, /src="assets\/index-DTblUuFQ\.js"/);
  assert.match(out, /src="images\/hero\.png"/);
  // Внешние и якорные ссылки не трогаем.
  const keep = rewritePreviewHtml('<a href="https://example.com/x">e</a><a href="/#section">s</a><a href="/">root</a><img src="//cdn.example.com/a.png">');
  assert.match(keep, /href="https:\/\/example\.com\/x"/);
  assert.match(keep, /href="\/#section"/);
  assert.match(keep, /href="\/"/);
  assert.match(keep, /src="\/\/cdn\.example\.com\/a\.png"/);
});

test('preview html gets a localStorage shim before any script', () => {
  // Sandbox-iframe без allow-same-origin: обращение к localStorage кидает
  // SecurityError и роняет SPA на старте (серый экран). Шим должен стоять
  // до первого скрипта страницы — сразу после <head>.
  const html = '<!doctype html><html><head><title>t</title></head><body><script type="module" src="assets/x.js"></script></body></html>';
  const out = rewritePreviewHtml(html);
  const shimAt = out.indexOf('__pv_probe');
  const scriptAt = out.indexOf('assets/x.js');
  assert.ok(shimAt > -1, 'шим присутствует');
  assert.ok(shimAt < scriptAt, 'шим до первого скрипта');
  // Без <head> шим ставится в начало документа.
  const noHead = rewritePreviewHtml('<!doctype html><html><body>BODYMARK</body></html>');
  assert.ok(noHead.indexOf('__pv_probe') > -1);
  assert.ok(noHead.indexOf('__pv_probe') < noHead.indexOf('BODYMARK'));
});

test('preview API mock is limited to Z Agent builds and exposes runtime capabilities', () => {
  const zAgent = rewritePreviewHtml('<!doctype html><html><head><meta name="app-version" content="z-agent-native-v1"></head><body></body></html>');
  assert.match(zAgent, /__previewMock/);
  assert.match(zAgent, /\/api\/runtime-capabilities/);

  const generic = rewritePreviewHtml('<!doctype html><html><head><title>Other SPA</title></head><body></body></html>');
  assert.match(generic, /__pv_probe/);
  assert.doesNotMatch(generic, /__previewMock/);
});

test('preview shim injection is idempotent', () => {
  const html = '<!doctype html><html><head><meta content="z-agent-native-v1" name="app-version"></head><body></body></html>';
  const once = rewritePreviewHtml(html);
  const twice = rewritePreviewHtml(once);
  assert.equal(twice, once);
});
