import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diffManifests, localManifest, parseRemoteManifest, verifyTarListing, shq, SYNC_EXCLUDES,
} from '../server/native/cloud-sandbox.mjs';

test('localManifest skips dependency dirs and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'x');
  fs.mkdirSync(path.join(root, 'node_modules/p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/p/i.js'), 'y');
  fs.symlinkSync('/etc/passwd', path.join(root, 'link'));
  const m = localManifest(root);
  assert.deepEqual([...m.keys()], ['src/a.js']);
  assert.ok(SYNC_EXCLUDES.includes('node_modules'));
});

test('diffManifests reports changed, new and removed files', () => {
  const before = new Map([['a', '1:1'], ['b', '1:1'], ['c', '1:1']]);
  const after = new Map([['a', '1:1'], ['b', '2:5'], ['d', '1:1']]);
  assert.deepEqual(diffManifests(before, after), { changed: ['b', 'd'], removed: ['c'] });
});

test('parseRemoteManifest reads find -printf output', () => {
  const m = parseRemoteManifest('src/a.js\t10\t1700000000.123\n./b\t3\t1.9\n\n');
  assert.equal(m.get('src/a.js'), '10:1700000000');
  assert.equal(m.get('b'), '3:1');
});

test('verifyTarListing refuses symlinks, hardlinks and devices', () => {
  verifyTarListing('-rw-r--r-- u/g 1 2026-01-01 00:00 a.txt\ndrwxr-xr-x u/g 0 2026-01-01 00:00 dir/\n');
  assert.throws(() => verifyTarListing('lrwxrwxrwx u/g 0 2026-01-01 00:00 evil -> /etc'), /refusing/);
  assert.throws(() => verifyTarListing('hrw-r--r-- u/g 0 2026-01-01 00:00 x link to y'), /refusing/);
  assert.throws(() => verifyTarListing('crw-r--r-- u/g 0 2026-01-01 00:00 dev'), /refusing/);
});

test('shq quotes single quotes safely', () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
});
