import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { activeTurnCount, startDurableRecovery } from './native/agent.mjs';
import { checkCsrf, requireAuth } from './native/auth.mjs';
import { DIST_DIR, MAX_JSON_BYTES, PORT } from './native/config.mjs';
import { listDurableJobs, pruneExpiredDurableJobs } from './native/durable-jobs.mjs';
import { readJson, sendJson } from './native/json.mjs';
import { assertRuntimeSecretsPrivate } from './native/sandbox.mjs';
import {
  ownsChat, recoverInterruptedRuntimeState,
} from './native/store.mjs';
import { initTerminal } from './native/terminal.mjs';
import { recoverDanglingTurnResults } from './native/turn-results.mjs';
import { handleWorkspace } from './native/workspace.mjs';
import { closeAllWorkspaceWatchers } from './native/watcher.mjs';
import { mintPreviewToken } from './native/preview-tokens.mjs';
import { handleAuthRoutes } from './routes/auth.mjs';
import { handleSystemRoutes } from './routes/system.mjs';
import { handleSessionRoutes } from './routes/sessions.mjs';
import { handleModelRoutes } from './routes/models.mjs';
import { handleTokenPreview, servePreviewFile } from './routes/preview.mjs';

const STARTED_AT = Date.now();
let DRAINING = false;
let SHUTTING_DOWN = false;
const SHUTDOWN_GRACE_MS = Math.min(Math.max(Number(process.env.Z_AGENT_SHUTDOWN_GRACE_MS) || 60_000, 5_000), 10 * 60 * 1000);
pruneExpiredDurableJobs();

const RESUMABLE_SESSIONS = listDurableJobs().map((job) => String(job.sessionId || '')).filter(Boolean);
recoverInterruptedRuntimeState({ skipSessionIds: RESUMABLE_SESSIONS });
const RECOVERED_TURNS = startDurableRecovery();
recoverDanglingTurnResults();

const APP_CONTENT_SECURITY_POLICY_BASE = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function errorResponse(res, err) {
  const status = Number(err?.statusCode) || (err?.name === 'AbortError' ? 499 : 500);
  const msg = err?.message || 'Internal Server Error';
  sendJson(res, status, { error: msg, code: err?.code || undefined });
}

function appSecurityHeaders(req) {
  const rawHost = String(req?.headers?.host || '').trim();
  const host = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(rawHost) ? rawHost : '';
  const sockets = host ? ` ws://${host} wss://${host}` : '';
  const csp = [...APP_CONTENT_SECURITY_POLICY_BASE, `connect-src 'self'${sockets} https://*.ingest.sentry.io https://*.ingest.us.sentry.io`].join('; ');
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': csp,
  };
}

function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
  if (decoded.includes('\0')) return sendJson(res, 400, { error: 'Bad request' });
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  let full = path.resolve(DIST_DIR, relative);
  if (!full.startsWith(path.resolve(DIST_DIR) + path.sep) && full !== path.resolve(DIST_DIR, 'index.html')) return sendJson(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.resolve(DIST_DIR, 'index.html');
  if (!fs.existsSync(full)) return sendJson(res, 503, { error: 'Frontend is not built. Run npm run build.' });
  const st = fs.statSync(full);
  const servedRelative = path.relative(DIST_DIR, full).split(path.sep).join('/');
  const immutableAsset = servedRelative.startsWith('assets/');
  res.writeHead(200, {
    'content-type': mimeFor(full),
    'content-length': st.size,
    'cache-control': immutableAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...appSecurityHeaders(req),
  });
  fs.createReadStream(full).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (await handleSystemRoutes(req, res, p, { draining: DRAINING, startedAt: STARTED_AT, isDraining: () => DRAINING })) return;
  if (await handleAuthRoutes(req, res, p)) return;
  if (handleTokenPreview(req, res, p)) return;

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!checkCsrf(req, res, auth)) return;
  const ownerId = auth.user.email;

  if (await handleSessionRoutes(req, res, p, url, ownerId)) return;
  if (await handleModelRoutes(req, res, p, url, ownerId)) return;

  if (p.startsWith('/api/workspace/') || p === '/api/file' || p.startsWith('/api/file/')) {
    const wsSid = url.searchParams.get('sessionId') || '';
    if (!wsSid || !ownsChat(wsSid, ownerId)) return sendJson(res, 404, { error: 'Session not found' });
    if (['PUT', 'POST'].includes(req.method || '') && String(req.headers['content-type'] || '').includes('application/json')) {
      req.bodyJson = await readJson(req, MAX_JSON_BYTES);
    }
    const handled = await handleWorkspace(req, res, wsSid, url);
    if (handled !== false) return;
  }

  if (p === '/api/workspace/preview-token' && req.method === 'GET') {
    const psid = url.searchParams.get('sessionId') || '';
    if (!psid || !ownsChat(psid, ownerId)) return sendJson(res, 404, { error: 'Session not found' });
    const token = mintPreviewToken(ownerId, psid);
    if (!token) return sendJson(res, 404, { error: 'Session not found' });
    return sendJson(res, 200, { base: `/api/preview/${token}/~/` });
  }

  const preview = /^\/api\/sandbox-proxy\/(ses_[A-Za-z0-9]+)\/~\/(.*)$/.exec(p);
  if (preview && req.method === 'GET') {
    const psid = preview[1];
    if (!ownsChat(psid, ownerId)) return sendJson(res, 404, { error: 'Not found' });
    return servePreviewFile(req, res, psid, preview[2]);
  }

  return sendJson(res, 404, { error: `Unknown route: ${req.method} ${p}` });
}

const server = http.createServer((req, res) => {
  Promise.resolve(route(req, res)).catch((err) => {
    console.error('[http]', req.method, req.url, err);
    errorResponse(res, err);
  });
});

assertRuntimeSecretsPrivate();
await initTerminal(server);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Z Agent Native listening on http://0.0.0.0:${PORT}${RECOVERED_TURNS ? ` · resumed ${RECOVERED_TURNS} durable turn(s)` : ''}`);
});

async function shutdown(signal = 'SIGTERM', { graceMs = SHUTDOWN_GRACE_MS } = {}) {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  DRAINING = true;
  console.log(`[shutdown] ${signal}: draining up to ${graceMs}ms (${activeTurnCount()} active turn(s))`);
  server.close();
  const deadline = Date.now() + graceMs;
  while (activeTurnCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const forced = activeTurnCount() > 0;
  if (forced) console.warn(`[shutdown] grace expired with ${activeTurnCount()} turn(s); durable recovery will resume them`);
  closeAllWorkspaceWatchers();
  try { server.closeIdleConnections?.(); } catch {}
  try { server.closeAllConnections?.(); } catch {}
  process.exit(forced ? 1 : 0);
}
process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err) => { console.error('[shutdown]', err); process.exit(1); }); });
process.on('SIGINT', () => { shutdown('SIGINT').catch((err) => { console.error('[shutdown]', err); process.exit(1); }); });

const FATAL_GRACE_MS = Math.min(SHUTDOWN_GRACE_MS, 5_000);
function fatal(kind, cause) {
  try {
    console.error(JSON.stringify({
      level: 'fatal',
      event: kind,
      at: new Date().toISOString(),
      activeTurns: activeTurnCount(),
      message: String(cause?.message || cause),
      stack: typeof cause?.stack === 'string' ? cause.stack.slice(0, 4000) : undefined,
    }));
  } catch {
    console.error('[fatal]', kind, cause);
  }
  shutdown(kind, { graceMs: FATAL_GRACE_MS }).catch(() => process.exit(1));
  setTimeout(() => process.exit(1), FATAL_GRACE_MS + 2_000).unref();
}
process.on('unhandledRejection', (reason) => { fatal('unhandledRejection', reason); });
process.on('uncaughtException', (err) => { fatal('uncaughtException', err); });
