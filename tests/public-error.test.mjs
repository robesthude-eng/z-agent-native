import assert from 'node:assert/strict';
import test from 'node:test';
import { publicErrorInfo, redactPaths } from '../server/native/public-error.mjs';

test('filesystem errors map to client statuses without leaking container paths', () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory, lstat '/work/ses_1/a.txt'"), { code: 'ENOENT' });
  assert.deepEqual(publicErrorInfo(missing).status, 404);
  assert.doesNotMatch(publicErrorInfo(missing).message, /\/work/);
  assert.equal(publicErrorInfo(Object.assign(new Error('x'), { code: 'ENOTDIR' })).status, 400);
  assert.equal(publicErrorInfo(Object.assign(new Error('x'), { code: 'EACCES' })).status, 403);
});

test('explicit statusCode and abort errors are preserved', () => {
  assert.deepEqual(publicErrorInfo(Object.assign(new Error('Конфликт'), { statusCode: 409, code: 'X' })), {
    status: 409,
    message: 'Конфликт',
    code: 'X',
  });
  assert.equal(publicErrorInfo(Object.assign(new Error('a'), { name: 'AbortError' })).status, 499);
});

test('other failures stay 500 with absolute paths redacted', () => {
  const info = publicErrorInfo(new Error("boom reading '/root/secret/file' now"));
  assert.equal(info.status, 500);
  assert.equal(info.message, "boom reading '<path>' now");
  assert.equal(redactPaths('plain text'), 'plain text');
  assert.equal(publicErrorInfo(new Error('')).message, 'Internal Server Error');
});

test('with a request ID an unexpected 500 hides the internal message', () => {
  const info = publicErrorInfo(new Error("boom reading '/root/secret/file'"), { requestId: 'abc123' });
  assert.equal(info.status, 500);
  assert.equal(info.requestId, 'abc123');
  assert.match(info.message, /abc123/);
  assert.doesNotMatch(info.message, /boom|secret/);
  assert.equal(publicErrorInfo(Object.assign(new Error('Конфликт'), { statusCode: 409 }), { requestId: 'abc123' }).message, 'Конфликт');
});
