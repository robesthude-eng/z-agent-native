import assert from 'node:assert/strict';
import test from 'node:test';

// Must be set before the module is imported: the ceiling is read once at import.
// node --test runs every test file in its own process, so this does not leak.
process.env.Z_AGENT_BROWSER_MAX_SESSIONS = '2';
const {
  browserSessionCapacity, closeAllBrowserSessions, closeBrowserSession, ensureBrowserSession,
} = await import('../server/native/browser.mjs');

// A Playwright double. The real thing would fork one Chromium per session, which
// is exactly the resource this cap exists to bound, so it must not be launched
// to test the cap.
function stubPlaywright() {
  const closed = [];
  let launched = 0;
  return {
    closed,
    launched: () => launched,
    playwright: {
      chromium: {
        launch: async () => {
          launched += 1;
          const id = launched;
          return {
            close: async () => { closed.push(`browser:${id}`); },
            newContext: async () => ({
              route: async () => {},
              routeWebSocket: async () => {},
              newPage: async () => ({ on: () => {} }),
              close: async () => { closed.push(`context:${id}`); },
            }),
          };
        },
      },
    },
  };
}

test('the in-process browser fallback never holds more Chromium sessions than its cap', async () => {
  const { playwright, closed, launched } = stubPlaywright();
  try {
    await ensureBrowserSession(playwright, 'ses_a');
    await ensureBrowserSession(playwright, 'ses_b');
    assert.deepEqual(browserSessionCapacity(), { active: 2, max: 2 });
    assert.deepEqual(closed, []);

    await ensureBrowserSession(playwright, 'ses_c');
    // Third session launched, but the process count did not grow past the cap.
    assert.equal(launched(), 3);
    assert.deepEqual(browserSessionCapacity(), { active: 2, max: 2 });
    assert.ok(closed.includes('browser:1'), `expected the oldest browser to be closed, got ${closed.join(',') || 'nothing'}`);
    assert.equal(await closeBrowserSession('ses_a'), false);
  } finally {
    await closeAllBrowserSessions();
  }
});

test('reusing a session refreshes its recency instead of launching a second browser', async () => {
  const { playwright, launched } = stubPlaywright();
  try {
    const first = await ensureBrowserSession(playwright, 'ses_a');
    await ensureBrowserSession(playwright, 'ses_b');
    assert.equal(await ensureBrowserSession(playwright, 'ses_a'), first);
    assert.equal(launched(), 2);

    // ses_a is now the most recently used, so ses_b is the eviction target even
    // though it was created later.
    await ensureBrowserSession(playwright, 'ses_c');
    assert.deepEqual(browserSessionCapacity(), { active: 2, max: 2 });
    assert.equal(await closeBrowserSession('ses_b'), false);
    assert.equal(await closeBrowserSession('ses_a'), true);
  } finally {
    await closeAllBrowserSessions();
  }
});

test('closing every session releases both the context and the browser', async () => {
  const { playwright, closed } = stubPlaywright();
  await ensureBrowserSession(playwright, 'ses_a');
  await ensureBrowserSession(playwright, 'ses_b');
  await closeAllBrowserSessions();
  assert.deepEqual(browserSessionCapacity(), { active: 0, max: 2 });
  assert.deepEqual(closed.sort(), ['browser:1', 'browser:2', 'context:1', 'context:2']);
});
