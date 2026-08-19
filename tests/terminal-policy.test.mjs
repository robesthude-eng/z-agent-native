import test from 'node:test';
import assert from 'node:assert/strict';

const { terminalEnabled } = await import('../server/native/terminal.mjs');

test('interactive terminal is fail-closed unless explicitly enabled', () => {
  const previous = process.env.Z_AGENT_TERMINAL_ENABLED;
  try {
    delete process.env.Z_AGENT_TERMINAL_ENABLED;
    assert.equal(terminalEnabled(), false);
    process.env.Z_AGENT_TERMINAL_ENABLED = '0';
    assert.equal(terminalEnabled(), false);
    process.env.Z_AGENT_TERMINAL_ENABLED = '1';
    assert.equal(terminalEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.Z_AGENT_TERMINAL_ENABLED;
    else process.env.Z_AGENT_TERMINAL_ENABLED = previous;
  }
});
