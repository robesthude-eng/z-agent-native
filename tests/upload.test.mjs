import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  PART_TOO_LARGE,
  boundaryFromContentType,
  fileSink,
  parseMultipartStream,
} from '../server/native/multipart.mjs';

const BOUNDARY = 'z-agent-test-boundary';

function multipartBody(parts, boundary = BOUNDARY) {
  const chunks = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function chunked(buffer, size) {
  const out = [];
  for (let i = 0; i < buffer.length; i += size) out.push(buffer.subarray(i, i + size));
  return out;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'z-upload-'));
}

test('streams file parts to disk across arbitrary chunk boundaries', async () => {
  const dir = tempDir();
  const payload = Buffer.from(`${'x'.repeat(5000)}КОНЕЦ`);
  const body = multipartBody([
    { name: 'meta', data: 'ignored field' },
    { name: 'file', filename: 'note.txt', data: payload },
  ]);
  // Seven byte reads guarantee delimiters are split across chunks.
  const result = await parseMultipartStream(Readable.from(chunked(body, 7)), BOUNDARY, {
    maxPartBytes: 1024 * 1024,
    openPart: ({ filename }) => (filename ? fileSink(path.join(dir, filename)) : null),
  });
  assert.equal(result.parts.length, 2);
  assert.equal(result.parts[0].skipped, true);
  const file = result.parts[1];
  assert.equal(file.filename, 'note.txt');
  assert.equal(file.size, payload.length);
  assert.equal(file.error, undefined);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'note.txt')), payload);
  // No temp file is left behind after a clean finish.
  assert.deepEqual(fs.readdirSync(dir), ['note.txt']);
});

test('caps one oversized part and leaves no partial file', async () => {
  const dir = tempDir();
  const body = multipartBody([{ name: 'file', filename: 'big.bin', data: Buffer.alloc(4096, 7) }]);
  const result = await parseMultipartStream(Readable.from(chunked(body, 512)), BOUNDARY, {
    maxPartBytes: 1024,
    openPart: ({ filename }) => fileSink(path.join(dir, filename)),
  });
  assert.equal(result.parts[0].error, PART_TOO_LARGE);
  assert.equal(result.parts[0].skipped, true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('rejects a request over the total cap', async () => {
  const dir = tempDir();
  const body = multipartBody([{ name: 'file', filename: 'big.bin', data: Buffer.alloc(8192, 3) }]);
  await assert.rejects(
    () =>
      parseMultipartStream(Readable.from(chunked(body, 1024)), BOUNDARY, {
        maxTotalBytes: 2048,
        openPart: ({ filename }) => fileSink(path.join(dir, filename)),
      }),
    (err) => err.statusCode === 413,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('rejects a truncated body instead of accepting a partial file', async () => {
  const dir = tempDir();
  const body = multipartBody([{ name: 'file', filename: 'cut.bin', data: Buffer.alloc(2048, 1) }]);
  const truncated = body.subarray(0, body.length - 40);
  await assert.rejects(
    () =>
      parseMultipartStream(Readable.from(chunked(truncated, 300)), BOUNDARY, {
        openPart: ({ filename }) => fileSink(path.join(dir, filename)),
      }),
    (err) => err.statusCode === 400,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('records a rejected part and keeps parsing the rest', async () => {
  const dir = tempDir();
  const body = multipartBody([
    { name: '../escape.txt', data: 'nope' },
    { name: 'ok.txt', data: 'yes' },
  ]);
  const result = await parseMultipartStream(Readable.from(chunked(body, 64)), BOUNDARY, {
    openPart: ({ name }) => {
      if (name.includes('..')) throw new Error('unsafe path');
      return fileSink(path.join(dir, name), { overwrite: true });
    },
  });
  assert.equal(result.parts[0].error, 'unsafe path');
  assert.equal(result.parts[1].error, undefined);
  assert.deepEqual(fs.readdirSync(dir), ['ok.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'ok.txt'), 'utf8'), 'yes');
});

test('does not clobber an existing file unless overwrite is requested', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'same.txt'), 'original');
  const body = multipartBody([{ name: 'file', filename: 'same.txt', data: 'replacement' }]);
  const result = await parseMultipartStream(Readable.from([body]), BOUNDARY, {
    openPart: ({ filename }) => fileSink(path.join(dir, filename)),
  });
  assert.match(result.parts[0].error || '', /EEXIST/);
  assert.equal(fs.readFileSync(path.join(dir, 'same.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(dir), ['same.txt']);
});

test('boundaryFromContentType handles quoted and bare boundaries', () => {
  assert.equal(boundaryFromContentType('multipart/form-data; boundary="a b c"'), 'a b c');
  assert.equal(boundaryFromContentType('multipart/form-data; boundary=simple; charset=utf-8'), 'simple');
  assert.equal(boundaryFromContentType('application/json'), null);
});
