import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPublicHttpUrl, readWorkspaceBrowserDocument } from '../server/native/browser-local.mjs';

test('public http(s) URLs stay on the network path', () => {
  assert.equal(isPublicHttpUrl('https://example.com/game'), true);
  assert.equal(isPublicHttpUrl('http://example.com/'), true);
  assert.equal(isPublicHttpUrl('index.html'), false);
  assert.equal(isPublicHttpUrl('file:///tmp/index.html'), false);
  assert.equal(isPublicHttpUrl('./index.html'), false);
  assert.equal(readWorkspaceBrowserDocument('/tmp', 'https://example.com/'), null);
});

test('workspace HTML is inlined for Chromium without touching the network', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-browser-local-'));
  fs.writeFileSync(path.join(root, 'style.css'), 'body{color:red}');
  fs.writeFileSync(path.join(root, 'index.html'), '<html><head><link rel="stylesheet" href="style.css"></head><body>шашки</body></html>\n');
  const doc = readWorkspaceBrowserDocument(root, 'index.html');
  assert.equal(doc.path, 'index.html');
  assert.equal(doc.href, 'workspace://index.html');
  assert.match(doc.html, /шашки/);
  assert.match(doc.html, /data:text\/css;base64,/);
  assert.doesNotMatch(doc.html, /href="style\.css"/);
  const fromTmp = readWorkspaceBrowserDocument(root, '/tmp/index.html');
  assert.equal(fromTmp.path, 'index.html');
  assert.throws(() => readWorkspaceBrowserDocument(root, 'missing.html'), /not found/i);
  fs.rmSync(root, { recursive: true, force: true });
});
