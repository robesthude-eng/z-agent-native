import assert from 'node:assert/strict';
import test from 'node:test';
import { exitCode } from './cli.js';
test('errors fail the CLI', () => assert.equal(exitCode({ errors: 2, warnings: 0 }), 1));
test('warnings alone do not fail', () => assert.equal(exitCode({ errors: 0, warnings: 2 }), 0));
