import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_INSTRUCTION_CHARS, loadProjectInstructions } from '../server/native/project-instructions.mjs';
import { SPILL_DIR, spillLargeOutput, spillThreshold } from '../server/native/tool-output-spill.mjs';
import { executeReadFile } from '../server/native/tools/filesystem.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zi-'));

test('AGENTS.md is loaded, CLAUDE.md is the fallback, first one wins', () => {
  const root = tmp();
  assert.equal(loadProjectInstructions(root), '');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'use tabs');
  assert.match(loadProjectInstructions(root), /use tabs/);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'run npm test');
  const text = loadProjectInstructions(root);
  assert.match(text, /run npm test/);
  assert.doesNotMatch(text, /use tabs/);
  assert.match(text, /never override the safety rules/);
});

test('long instructions are truncated and the feature can be switched off', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(MAX_INSTRUCTION_CHARS + 500));
  assert.match(loadProjectInstructions(root), /\[truncated: read AGENTS\.md/);
  process.env.Z_AGENT_PROJECT_INSTRUCTIONS = 'off';
  try {
    assert.equal(loadProjectInstructions(root), '');
  } finally {
    delete process.env.Z_AGENT_PROJECT_INSTRUCTIONS;
  }
});

test('AGENTS.md symlink pointing outside the workspace is not followed', () => {
  const root = tmp();
  const outside = path.join(tmp(), 'secret.md');
  fs.writeFileSync(outside, 'TOP SECRET');
  fs.symlinkSync(outside, path.join(root, 'AGENTS.md'));
  assert.equal(loadProjectInstructions(root), '');
});

test('large tool output is spilled to a readable workspace file', async () => {
  const root = tmp();
  const text = `${'a'.repeat(20_000)}MIDDLE${'b'.repeat(30_000)}`;
  const spilled = spillLargeOutput({ workspace: root, callId: 'call_1', toolName: 'bash', text });
  assert.ok(spilled);
  assert.ok(spilled.content.length < 14_000);
  assert.ok(spilled.file.startsWith(`${SPILL_DIR}/`));
  assert.equal(fs.readFileSync(path.join(root, spilled.file), 'utf8'), text);
  const read = await executeReadFile(root, { path: spilled.file, offset: 0, limit: 5 });
  assert.match(String(read.output ?? read), /a{10}/);
});

test('small output, read tool and disabled threshold are left alone', () => {
  const root = tmp();
  assert.equal(spillLargeOutput({ workspace: root, callId: 'c', toolName: 'bash', text: 'short' }), null);
  assert.equal(spillLargeOutput({ workspace: root, callId: 'c', toolName: 'read', text: 'x'.repeat(50_000) }), null);
  assert.equal(spillLargeOutput({ workspace: root, callId: 'c', toolName: 'bash', text: 'x'.repeat(50_000), threshold: 0 }), null);
  assert.equal(spillThreshold({ Z_AGENT_TOOL_SPILL_CHARS: '0' }), 0);
  assert.equal(spillThreshold({}), 32_000);
});

test('old spill files are pruned', () => {
  const root = tmp();
  for (let i = 0; i < 45; i++)
    spillLargeOutput({ workspace: root, callId: `c${i}`, toolName: 'bash', text: 'x'.repeat(40_000), now: Date.now() + i });
  assert.ok(fs.readdirSync(path.join(root, SPILL_DIR)).length <= 40);
});
