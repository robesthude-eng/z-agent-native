import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
