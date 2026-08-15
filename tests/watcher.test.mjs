import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { subscribe, resetEventsForTests } from '../server/native/events.mjs';
import { ensureWorkspaceWatcher, closeWorkspaceWatcher } from '../server/native/watcher.mjs';

async function waitFor(fn, timeout = 1500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('watcher event timeout');
}

test('workspace watcher turns out-of-band filesystem writes into native realtime events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-watch-'));
  const sid = 'ses_watchnative1';
  const seen = [];
  const unsubscribe = subscribe(sid, (frame) => seen.push(frame.event));
  assert.ok(ensureWorkspaceWatcher(sid, root));
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project', 'from-terminal.txt'), 'hello');
  const event = await waitFor(() => seen.find((item) => item.type === 'file.watcher.updated'));
  assert.equal(event.properties.sessionID, sid);
  assert.ok(Array.isArray(event.properties.paths));
  closeWorkspaceWatcher(sid);
  unsubscribe();
  resetEventsForTests();
  fs.rmSync(root, { recursive: true, force: true });
});
