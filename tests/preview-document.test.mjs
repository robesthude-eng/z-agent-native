import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewDocument, previewIsReady } from '../server/native/preview-document.mjs';

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
