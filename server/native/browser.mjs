import { assertSafeExternalUrl } from './security.mjs';
import { assertAgentNetworkUrl } from './workspace-policy.mjs';

const MAX_SNAPSHOT_CHARS = 40_000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONTROLS = 120;
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const SESSION_IDLE_MS = 10 * 60 * 1000;

export const BROWSER_ACTIONS = ['open', 'snapshot', 'click', 'fill', 'press', 'console', 'close'];

// Playwright is an optional runtime dependency. The same degradation pattern as
// terminal.mjs/socket.io: never let a missing optional module break startup or
// the rest of the tool surface.
let playwrightModule;
let playwrightError = '';

export async function loadPlaywright() {
  if (playwrightModule !== undefined) return playwrightModule;
  try {
    playwrightModule = await import('playwright');
    return playwrightModule;
  } catch (error) {
    playwrightError = error?.message || String(error);
  }
  try {
    playwrightModule = await import('@playwright/test');
    return playwrightModule;
  } catch (error) {
    playwrightError = error?.message || String(error);
    playwrightModule = null;
    return playwrightModule;
  }
}

export function browserUnavailableMessage() {
  return [
    'Browser automation is unavailable: Playwright could not be loaded in this runtime',
    playwrightError ? ` (${playwrightError})` : '',
    '. Install it with "npm i -D playwright && npx playwright install --with-deps chromium", or use webfetch for static pages.',
  ].join('');
}

const sessions = new Map();

function timeoutFor(input) {
  return Math.min(Math.max(Number(input?.timeoutMs) || DEFAULT_ACTION_TIMEOUT_MS, 1000), MAX_ACTION_TIMEOUT_MS);
}

async function disposeSession(state) {
  try { await state.context?.close(); } catch { /* context may already be gone */ }
  try { await state.browser?.close(); } catch { /* browser may already be gone */ }
}

export async function closeBrowserSession(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) return false;
  sessions.delete(sessionId);
  await disposeSession(state);
  return true;
}

export async function sweepIdleBrowserSessions() {
  const now = Date.now();
  for (const [key, state] of sessions) {
    if (now - state.lastUsed <= SESSION_IDLE_MS) continue;
    sessions.delete(key);
    await disposeSession(state);
  }
}

export async function closeAllBrowserSessions() {
  const states = [...sessions.values()];
  sessions.clear();
  await Promise.all(states.map((state) => disposeSession(state)));
}

async function ensureSession(playwright, sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  const proxyServer = String(process.env.Z_AGENT_BROWSER_PROXY || '').trim();
  const browser = await playwright.chromium.launch({
    headless: true,
    // Chromium is already a non-root process in a no-secret/no-workspace
    // container. Its only network path is the dedicated policy proxy when the
    // production Compose topology is used.
    chromiumSandbox: false,
    args: ['--disable-dev-shm-usage'],
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });
  const context = await browser.newContext({
    acceptDownloads: false,
    bypassCSP: false,
    javaScriptEnabled: true,
    // Service workers can otherwise satisfy/fan out requests outside Playwright
    // routing, bypassing the per-request network policy below.
    serviceWorkers: 'block',
  });
  const state = { browser, context, page: null, console: [], lastUsed: Date.now() };
  await context.route('**/*', async (route) => {
    const request = route.request();
    const target = request.url();
    try {
      const parsed = new URL(target);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        assertAgentNetworkUrl(target, { tool: 'browser' });
        // Keep an in-process validation layer for fast failure. Production also
        // forces Chromium through browser-egress, which resolves/validates again
        // and pins the actual upstream address at CONNECT/request time.
        await assertSafeExternalUrl(target);
      }
      await route.continue();
    } catch (error) {
      state.console.push(`[blocked-request] ${request.method()} ${target.slice(0, 200)} :: ${String(error?.message || error).slice(0, 300)}`);
      if (state.console.length > MAX_CONSOLE_ENTRIES) state.console.shift();
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
  // WebSockets are not covered by ordinary request routing and are not needed
  // for the agent's verification browser. Refuse them instead of leaving a
  // second ungoverned egress/SSRF channel.
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', (socket) => socket.close());
  }
  const page = await context.newPage();
  state.page = page;
  const record = (entry) => {
    state.console.push(entry);
    if (state.console.length > MAX_CONSOLE_ENTRIES) state.console.shift();
  };
  page.on('console', (message) => {
    record(`[${message.type()}] ${String(message.text()).slice(0, 500)}`);
  });
  page.on('pageerror', (error) => {
    record(`[pageerror] ${String(error?.message || error).slice(0, 500)}`);
  });
  page.on('requestfailed', (request) => {
    record(`[requestfailed] ${request.method()} ${request.url().slice(0, 200)} :: ${request.failure()?.errorText || 'unknown'}`);
  });
  sessions.set(sessionId, state);
  return state;
}

function resolveLocator(page, input) {
  const selector = String(input?.selector || '').trim();
  if (selector) return page.locator(selector).first();
  const text = String(input?.text || '').trim();
  if (text) return page.getByText(text, { exact: false }).first();
  throw new Error('This action requires either selector (CSS) or text');
}

async function collectSnapshot(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const text = await page
    .evaluate(() => (document.body ? document.body.innerText : ''))
    .catch(() => '');
  const controls = await page
    .evaluate((limit) => {
      const rows = [];
      const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]');
      for (let i = 0; i < nodes.length && rows.length < limit; i += 1) {
        const node = nodes[i];
        const tag = node.tagName.toLowerCase();
        const raw = node.getAttribute('aria-label')
          || node.getAttribute('placeholder')
          || node.getAttribute('name')
          || node.textContent
          || '';
        const label = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
        const id = node.id ? `#${node.id}` : '';
        const type = node.getAttribute('type');
        rows.push(`${tag}${type ? `[type=${type}]` : ''}${id} :: ${label}`);
      }
      return rows;
    }, MAX_CONTROLS)
    .catch(() => []);

  const trimmed = String(text || '').replace(/\n{3,}/g, '\n\n').slice(0, MAX_SNAPSHOT_CHARS);
  return { url, title, text: trimmed, controls };
}

function formatSnapshot(snapshot, extra = []) {
  return [
    `url: ${snapshot.url}`,
    `title: ${snapshot.title}`,
    ...extra,
    '',
    'interactive elements:',
    snapshot.controls.length ? snapshot.controls.map((row) => `  - ${row}`).join('\n') : '  (none detected)',
    '',
    '--- page text ---',
    snapshot.text || '(empty)',
  ].join('\n');
}

export async function executeBrowserTool({ sessionId, input = {}, signal }) {
  const action = String(input.action || '').trim().toLowerCase();
  if (!BROWSER_ACTIONS.includes(action)) {
    throw new Error(`Unsupported browser action "${input.action}". Use one of: ${BROWSER_ACTIONS.join(', ')}`);
  }
  if (!sessionId) throw new Error('Browser automation requires a session sandbox');

  if (action === 'close') {
    const closed = await closeBrowserSession(sessionId);
    return {
      output: closed ? 'Browser session closed.' : 'No browser session was open.',
      title: 'browser close',
      metadata: { browser: { action } },
    };
  }

  // Fail closed on destination policy before loading/launching Chromium.
  // Workspace HTML arrives as `html` and never hits the network.
  if (action === 'open') {
    const html = String(input.html || '');
    const target = String(input.url || '').trim();
    if (!html && !target) throw new Error('open requires url');
    if (!html) assertAgentNetworkUrl(target, { tool: 'browser' });
  }

  const playwright = await loadPlaywright();
  if (!playwright) throw new Error(browserUnavailableMessage());

  await sweepIdleBrowserSessions();
  if (signal?.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });

  const state = await ensureSession(playwright, sessionId);
  state.lastUsed = Date.now();
  const page = state.page;
  const timeout = timeoutFor(input);
  const extra = [];

  if (action === 'open') {
    const html = String(input.html || '');
    const target = String(input.url || '').trim();
    if (html) {
      await page.setContent(html, { timeout, waitUntil: 'domcontentloaded' });
      extra.push(`workspace document: ${target || 'inline'}`);
    } else {
      if (!target) throw new Error('open requires url');
      // Same SSRF policy as webfetch: no loopback, no private ranges, no
      // non-http schemes. Navigation is still a live fetch, so this check is a
      // policy gate rather than a pinned connection.
      assertAgentNetworkUrl(target, { tool: 'browser' });
      await assertSafeExternalUrl(target);
      const response = await page.goto(target, { timeout, waitUntil: 'domcontentloaded' });
      extra.push(`http status: ${response ? response.status() : 'unknown'}`);
    }
  } else if (action === 'click') {
    await resolveLocator(page, input).click({ timeout });
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    extra.push('clicked');
  } else if (action === 'fill') {
    await resolveLocator(page, input).fill(String(input.value ?? ''), { timeout });
    extra.push('filled');
  } else if (action === 'press') {
    const key = String(input.key || '').trim();
    if (!key) throw new Error('press requires key, for example "Enter"');
    await resolveLocator(page, input).press(key, { timeout });
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    extra.push(`pressed ${key}`);
  } else if (action === 'console') {
    return {
      output: state.console.length ? state.console.join('\n') : 'No console output captured yet.',
      title: 'browser console',
      metadata: { browser: { action, entries: state.console.length } },
    };
  }

  const snapshot = await collectSnapshot(page);
  const recentErrors = state.console.filter((row) => row.startsWith('[error]') || row.startsWith('[pageerror]')).slice(-5);
  if (recentErrors.length) extra.push(`console errors: ${recentErrors.length} (use action="console" for the full log)`);

  return {
    output: formatSnapshot(snapshot, extra),
    title: `browser ${action}: ${snapshot.title || snapshot.url}`,
    metadata: { browser: { action, url: snapshot.url, consoleEntries: state.console.length } },
  };
}
