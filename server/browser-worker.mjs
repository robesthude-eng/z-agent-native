import readline from 'node:readline';
import { closeAllBrowserSessions, executeBrowserTool, loadPlaywright } from './native/browser.mjs';

const sessionId = String(process.argv[2] || '');
if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('browser worker requires a valid session id');
const PREFIX = 'ZAGENT_BROWSER_RESPONSE ';

const playwright = await loadPlaywright();
if (!playwright) throw new Error('Playwright/Chromium is unavailable in browser worker');

function reply(payload) {
  process.stdout.write(`${PREFIX}${JSON.stringify(payload)}\n`);
}

let chain = Promise.resolve();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  chain = chain.then(async () => {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    const id = String(message?.id || '');
    if (!id) return;
    try {
      const result = await executeBrowserTool({ sessionId, input: message.input || {} });
      reply({ id, ok: true, result });
      if (String(message?.input?.action || '').toLowerCase() === 'close') process.exitCode = 0;
    } catch (error) {
      reply({ id, ok: false, error: error?.message || String(error), code: error?.code || 'BROWSER_WORKER_ERROR' });
    }
  }).catch(() => {});
});

async function shutdown(code = 0) {
  try { input.close(); } catch {}
  await closeAllBrowserSessions().catch(() => {});
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { shutdown(0).catch(() => process.exit(1)); });
process.stdin.on('end', () => { chain.finally(() => shutdown(process.exitCode || 0)).catch(() => process.exit(1)); });

// Crashing straight out of this process would skip closeAllBrowserSessions and
// orphan the Chromium processes it spawned, which then survive as untracked
// children holding memory and profile directories. Route a fatal through the
// same shutdown the signals use. Diagnostics go to stderr, never stdout, which
// carries the framed response protocol the controller parses.
function fatal(kind, cause) {
  try {
    console.error(JSON.stringify({
      level: 'fatal',
      service: 'browser-worker',
      event: kind,
      at: new Date().toISOString(),
      sessionId,
      message: String(cause?.message || cause),
      stack: typeof cause?.stack === 'string' ? cause.stack.slice(0, 4000) : undefined,
    }));
  } catch {
    console.error('[browser-worker]', kind, cause);
  }
  process.exitCode = 1;
  shutdown(1).catch(() => process.exit(1));
}
process.on('unhandledRejection', (reason) => { fatal('unhandledRejection', reason); });
process.on('uncaughtException', (error) => { fatal('uncaughtException', error); });
