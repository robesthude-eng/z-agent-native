import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  abortTurn, activeTurnCount, answerQuestion, clearAgentSessionState, rejectQuestion, startDurableRecovery, submitTurn, waitForTurnIdle,
} from './native/agent.mjs';
import {
  authFromRequest, changePassword, checkCsrf, clearCookies, issueLogin,
  loginUser, logoutToken, registerUser, requireAuth,
} from './native/auth.mjs';
import { DIST_DIR, MAX_JSON_BYTES, PORT, SECURE_COOKIES, TRUST_PROXY } from './native/config.mjs';
import { listDurableJobs, pruneExpiredDurableJobs } from './native/durable-jobs.mjs';
import { clearSessionEvents, emit, openSse } from './native/events.mjs';
import { assertActionId, sessionId } from './native/ids.mjs';
import { readJson, sendJson } from './native/json.mjs';
import { handleProviderChannels } from './native/provider-channels.mjs';
import {
  buildCatalog, providerList, providerSpecs,
} from './native/providers.mjs';
import { safeWorkspacePath } from './native/security.mjs';
import { readinessCheck } from './native/readiness.mjs';
import { prometheusMetrics } from './native/metrics.mjs';
import { killExecutorIdentity } from './native/executor-client.mjs';
import { closeBrowserSessionRemote } from './native/browser-client.mjs';
import { assertRuntimeSecretsPrivate, killSandboxProcesses, shellSandboxAvailable } from './native/sandbox.mjs';
import {
  authRateLimitExceeded, createChat, deleteChat, deleteMessagesFrom, deleteProviderKey,
  dequeueAction, enqueueAction, getChat, getPrefs, getTurn,
  listChats, listMessages, listPendingQuestions,
  listProviderKeyIds, listQueue, ownsChat, recordAuthFailures, recoverInterruptedRuntimeState, renameChat, setPrefs,
  setProviderKey, workspaceFor, getSandboxUid,
} from './native/store.mjs';
import { initTerminal, terminalEnabled } from './native/terminal.mjs';
import { recoverDanglingTurnResults } from './native/turn-results.mjs';
import { handleWorkspace } from './native/workspace.mjs';
import { closeAllWorkspaceWatchers, closeWorkspaceWatcher, ensureWorkspaceWatcher } from './native/watcher.mjs';
import { previewDocument } from './native/preview-document.mjs';
import { mintPreviewToken, resolvePreviewToken, revokePreviewTokens } from './native/preview-tokens.mjs';

const STARTED_AT = Date.now();
let DRAINING = false;
let SHUTTING_DOWN = false;
const SHUTDOWN_GRACE_MS = Math.min(Math.max(Number(process.env.Z_AGENT_SHUTDOWN_GRACE_MS) || 60_000, 5_000), 10 * 60 * 1000);
pruneExpiredDurableJobs();
// Resumable sessions must be identified BEFORE the generic recovery sweep,
// otherwise the sweep rejects the pending questions and permissions that those
// durable jobs are about to resume.
const RESUMABLE_SESSIONS = listDurableJobs().map((job) => String(job.sessionId || '')).filter(Boolean);
recoverInterruptedRuntimeState({ skipSessionIds: RESUMABLE_SESSIONS });
const RECOVERED_TURNS = startDurableRecovery();
recoverDanglingTurnResults();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_IP_MAX_FAILURES = 40;
const AUTH_ACCOUNT_MAX_FAILURES = 15;

function authRemoteAddress(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket?.remoteAddress || 'unknown');
}

function authBucket(kind, value) {
  return `${kind}:${crypto.createHash('sha256').update(String(value || '').trim().toLowerCase(), 'utf8').digest('hex')}`;
}

function authRateBuckets(req, email = '') {
  const ip = authBucket('ip', authRemoteAddress(req));
  const account = String(email || '').trim() ? authBucket('account', email) : null;
  return { ip, account, all: [ip, account].filter(Boolean) };
}

function checkAuthRate(req, email = '') {
  const buckets = authRateBuckets(req, email);
  const limits = { [buckets.ip]: AUTH_IP_MAX_FAILURES, default: AUTH_ACCOUNT_MAX_FAILURES };
  if (buckets.account) limits[buckets.account] = AUTH_ACCOUNT_MAX_FAILURES;
  return !authRateLimitExceeded(buckets.all, limits);
}

function noteAuthFailure(req, email = '') {
  recordAuthFailures(authRateBuckets(req, email).all, { windowMs: AUTH_WINDOW_MS });
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  if (SECURE_COOKIES) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

function errorResponse(res, err) {
  if (res.headersSent || res.writableEnded) return;
  const status = Number(err?.statusCode) || 500;
  const requestId = String(res.getHeader('x-request-id') || '');
  sendJson(res, status, status >= 500
    ? { error: 'Internal server error', ...(requestId ? { requestId } : {}) }
    : { error: err?.message || 'Request failed', ...(requestId ? { requestId } : {}) });
}

function mergePrefs(current, patch) {
  const out = { ...(current || {}) };
  for (const [key, incoming] of Object.entries(patch || {})) {
    if (!incoming || typeof incoming !== 'object') continue;
    const old = out[key];
    const inAt = Number(incoming.updatedAt) || 0;
    const oldAt = Number(old?.updatedAt) || 0;
    if (inAt >= oldAt) out[key] = incoming;
  }
  return out;
}

function sanitizeTitle(value) {
  const s = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().replace(/\s+/g, ' ');
  return s.slice(0, 120) || 'Новый чат';
}

function decodePathPart(value) {
  try { return decodeURIComponent(value); }
  catch { throw Object.assign(new Error('Bad request'), { statusCode: 400 }); }
}

function sessionFromPath(pathname) {
  return /^\/api\/session\/(ses_[A-Za-z0-9]+)(?:\/|$)/.exec(pathname)?.[1] || null;
}

function mimeFor(full) {
  const ext = path.extname(full).toLowerCase();
  // Missing entries fell back to application/octet-stream, which makes the
  // browser refuse the asset: .wasm never reaches instantiateStreaming, .ico
  // and the fonts are dropped, and .map breaks devtools on the preview server.
  return ({ '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.wasm':'application/wasm','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.mp4':'video/mp4','.webm':'video/webm','.xml':'application/xml; charset=utf-8','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8' })[ext] || 'application/octet-stream';
}

async function route(req, res) {
  securityHeaders(res);
  const requestId = crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/health/live') return sendJson(res, 200, { status: 'alive', runtime: 'z-agent-native', version: '1.0.0', uptime: Math.floor((Date.now() - STARTED_AT) / 1000) });
  if (p === '/metrics' && req.method === 'GET') {
    const expected = String(process.env.Z_AGENT_METRICS_TOKEN || '');
    if (!expected) return sendJson(res, 404, { error: 'Not found' });
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(supplied); const b = Buffer.from(expected);
    const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
    if (!ok) return sendJson(res, 401, { error: 'Unauthorized' });
    const body = Buffer.from(prometheusMetrics({ activeTurns: activeTurnCount() }));
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (p === '/health' || p === '/health/ready' || p === '/api/global/health' || p === '/global/health') {
    if (DRAINING) return sendJson(res, 503, { status: 'draining', runtime: 'z-agent-native', version: '1.0.0', uptime: Math.floor((Date.now() - STARTED_AT) / 1000), checks: {} });
    const readiness = await readinessCheck();
    // Health is commonly exposed through a reverse proxy. Never reflect raw
    // exception strings/paths from DB, volume or IPC probes to unauthenticated
    // callers; operators get detail from logs/metrics instead.
    const checks = Object.fromEntries(Object.entries(readiness.checks || {}).map(([name, value]) => [name, {
      ok: Boolean(value?.ok), latencyMs: Number(value?.latencyMs) || 0,
    }]));
    return sendJson(res, readiness.ok ? 200 : 503, {
      status: readiness.ok ? 'ok' : 'not_ready', runtime: 'z-agent-native', version: '1.0.0',
      uptime: Math.floor((Date.now() - STARTED_AT) / 1000), checks,
    });
  }

  // Authentication endpoints intentionally precede the auth gate.
  if (p === '/api/auth/register' && req.method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    if (!checkAuthRate(req, body.email)) return sendJson(res, 429, { error: 'Слишком много попыток. Повторите позже.' });
    let user;
    try { user = registerUser(body.email, body.password, body.inviteCode); }
    catch (error) { noteAuthFailure(req, body.email); throw error; }
    const login = issueLogin(user.email);
    return sendJson(res, 200, { status: 'success', user: { email: user.email, role: user.role } }, { 'set-cookie': login.cookies });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    if (!checkAuthRate(req, body.email)) return sendJson(res, 429, { error: 'Слишком много попыток. Повторите позже.' });
    let user;
    try { user = loginUser(body.email, body.password); }
    catch (error) { noteAuthFailure(req, body.email); throw error; }
    const login = issueLogin(user.email);
    return sendJson(res, 200, { status: 'success', user: { email: user.email, role: user.role } }, { 'set-cookie': login.cookies });
  }
  if (p === '/api/auth/me' && req.method === 'GET') {
    const auth = authFromRequest(req);
    return auth ? sendJson(res, 200, { status: 'success', user: { email: auth.user.email, role: auth.user.role } }) : sendJson(res, 401, { error: 'Unauthorized' });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const auth = authFromRequest(req);
    if (auth && !checkCsrf(req, res, auth)) return;
    if (auth) logoutToken(auth.token);
    return sendJson(res, 200, { status: 'success' }, { 'set-cookie': clearCookies() });
  }

  // Файлы превью по маркеру в пути. Роут намеренно стоит ДО авторизации:
  // запросы приходят из iframe с непрозрачным origin, и куку SameSite=Lax
  // браузер к ним не прикладывает. Право чтения подтверждает сам маркер,
  // а владение чатом перепроверяется на каждый файл.
  const tokenPreview = /^\/api\/preview\/([a-f0-9]{64})\/~\/(.*)$/.exec(p);
  if (tokenPreview && req.method === 'GET') {
    const grant = resolvePreviewToken(tokenPreview[1]);
    if (!grant || !ownsChat(grant.sessionId, grant.ownerId)) return sendJson(res, 404, { error: 'Not found' });
    return servePreviewFile(req, res, grant.sessionId, tokenPreview[2]);
  }

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!checkCsrf(req, res, auth)) return;
  const ownerId = auth.user.email;

  if (p === '/api/ui-config' && req.method === 'GET') {
    // Runtime owns its system prompt. The field remains for old frontends but
    // is intentionally empty so policy is never round-tripped through browser state.
    return sendJson(res, 200, { systemInstruction: '', runtime: 'z-agent-native', version: '1.0.0' });
  }
  if (p === '/api/auth/change-password' && req.method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    const revokedSessions = changePassword(ownerId, body.currentPassword, body.newPassword, auth.token);
    return sendJson(res, 200, { status: 'success', revokedSessions });
  }

  if (p === '/api/session' && req.method === 'GET') return sendJson(res, 200, listChats(ownerId));
  if (p === '/api/session' && req.method === 'POST') {
    const body = await readJson(req, MAX_JSON_BYTES);
    const chat = createChat(sessionId(), ownerId, sanitizeTitle(body.title));
    ensureWorkspaceWatcher(chat.id, workspaceFor(chat.id));
    emit(chat.id, 'session.created', { session: chat });
    return sendJson(res, 200, chat);
  }

  // Native SSE. A session stream is the only realtime transport for chat/tool/file state.
  if (p === '/api/event' && req.method === 'GET') {
    const sid = url.searchParams.get('sessionId');
    if (!sid || !ownsChat(sid, ownerId)) return sendJson(res, 403, { error: 'Forbidden' });
    ensureWorkspaceWatcher(sid, workspaceFor(sid));
    return openSse(req, res, sid, url.searchParams.get('lastEventId') || req.headers['last-event-id'] || 0);
  }

  const sid = sessionFromPath(p);
  if (sid) {
    if (!ownsChat(sid, ownerId)) return sendJson(res, 404, { error: 'Session not found' });
    if (p === `/api/session/${sid}` && req.method === 'GET') return sendJson(res, 200, getChat(sid, ownerId));
    if (p === `/api/session/${sid}` && req.method === 'PATCH') {
      const body = await readJson(req, 64 * 1024);
      const chat = renameChat(sid, ownerId, sanitizeTitle(body.title));
      emit(sid, 'session.updated', { session: chat });
      return sendJson(res, 200, { ok: true, id: sid, title: chat.title });
    }
    if (p === `/api/session/${sid}` && req.method === 'DELETE') {
      abortTurn(sid);
      if (!(await waitForTurnIdle(sid, 5000))) return sendJson(res, 409, { error: 'Agent turn is still stopping; retry deletion.' });
      killSandboxProcesses(sid);
      const sandboxUid = getSandboxUid(sid);
      if (Number.isInteger(sandboxUid)) await killExecutorIdentity(sandboxUid);
      await closeBrowserSessionRemote(sid, sandboxUid);
      closeWorkspaceWatcher(sid);
      emit(sid, 'session.removed', {});
      deleteChat(sid, ownerId);
      // Вместе с чатом гаснет и выданный на него маркер превью.
      revokePreviewTokens(sid);
      clearAgentSessionState(sid);
      clearSessionEvents(sid);
      return sendJson(res, 204, null);
    }
    if (p === `/api/session/${sid}/message` && req.method === 'GET') return sendJson(res, 200, listMessages(sid));
    if (p === `/api/session/${sid}/message` && req.method === 'POST') {
      const body = await readJson(req, MAX_JSON_BYTES);
      const result = await submitTurn({ sessionId: sid, ownerId, parts: body.parts || [], model: body.model || null, system: '', actionId: req.headers['x-action-id'] || '' });
      return sendJson(res, 200, result);
    }
    if (p === `/api/session/${sid}/abort` && req.method === 'POST') {
      abortTurn(sid);
      await waitForTurnIdle(sid, 5000);
      return sendJson(res, 204, null);
    }
    if (p === `/api/session/${sid}/revert` && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      abortTurn(sid);
      if (!(await waitForTurnIdle(sid, 5000))) return sendJson(res, 409, { error: 'Agent turn is still stopping; retry revert.' });
      const removed = deleteMessagesFrom(sid, body.messageID);
      emit(sid, 'stream.reconnected', { reason: 'history_reverted' });
      return sendJson(res, 200, { ok: true, removed });
    }
    if (p === `/api/session/${sid}/turn` && req.method === 'GET') return sendJson(res, 200, { turn: getTurn(sid), orchestrator: true });
    if (p === `/api/session/${sid}/capabilities` && req.method === 'GET') {
      const previewPath = previewDocument(workspaceFor(sid));
      return sendJson(res, 200, {
        capabilities: {
          terminal: terminalEnabled() && shellSandboxAvailable() ? 'ready' : 'unavailable',
          workspace: 'ready',
          preview: previewPath ? 'ready' : 'unavailable',
        },
        previewPath: previewPath || null,
      });
    }
    if (p === `/api/session/${sid}/queue` && req.method === 'GET') return sendJson(res, 200, { queue: listQueue(sid) });
    if (p === `/api/session/${sid}/queue` && req.method === 'POST') {
      const body = await readJson(req, 128 * 1024);
      const actionId = assertActionId(body.actionId);
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload
        : {};
      if (typeof payload.text !== 'string' || (payload.attachments !== undefined && !Array.isArray(payload.attachments))) {
        return sendJson(res, 400, { error: 'Invalid queue payload' });
      }
      return sendJson(res, 200, { outcome: enqueueAction(sid, actionId, payload) });
    }
    if (p === `/api/session/${sid}/queue` && req.method === 'DELETE') {
      return sendJson(res, 200, {
        removed: dequeueAction(sid, assertActionId(url.searchParams.get('actionId'))),
      });
    }
  }

  // Question protocol is native: one pending question belongs to one active turn.
  if (p === '/api/question' && req.method === 'GET') {
    const qsid = url.searchParams.get('sessionId') || '';
    if (!ownsChat(qsid, ownerId)) return sendJson(res, 404, { error: 'Session not found' });
    return sendJson(res, 200, listPendingQuestions(qsid));
  }
  const qReply = /^\/api\/question\/([^/]+)\/(reply|reject)$/.exec(p);
  if (qReply && req.method === 'POST') {
    const qsid = url.searchParams.get('sessionId') || '';
    if (!ownsChat(qsid, ownerId)) return sendJson(res, 404, { error: 'Session not found' });
    const id = decodePathPart(qReply[1]);
    if (qReply[2] === 'reply') {
      const body = await readJson(req, 128 * 1024);
      return answerQuestion(qsid, id, Array.isArray(body.answers) ? body.answers : []) ? sendJson(res, 204, null) : sendJson(res, 404, { error: 'Question not found' });
    }
    return rejectQuestion(qsid, id) ? sendJson(res, 204, null) : sendJson(res, 404, { error: 'Question not found' });
  }

  // User preferences.
  if (p === '/api/user/prefs' && req.method === 'GET') return sendJson(res, 200, getPrefs(ownerId));
  if (p === '/api/user/prefs' && req.method === 'PUT') {
    const patch = await readJson(req, 512 * 1024);
    const prefs = mergePrefs(getPrefs(ownerId), patch);
    setPrefs(ownerId, prefs);
    return sendJson(res, 200, { ok: true, prefs });
  }

  // ZCode-style owner-scoped provider channels: provider first, models second.
  if (await handleProviderChannels(req, res, ownerId, url)) return;

  // Provider keys and live model catalog.
  if (p === '/api/config/providers' && req.method === 'GET') return sendJson(res, 200, { providers: providerList(ownerId), default: {} });
  if (p === '/api/provider' && req.method === 'GET') return sendJson(res, 200, { connected: listProviderKeyIds(ownerId), all: providerList(ownerId), default: {} });
  if (p === '/api/auth/custom' && req.method === 'GET') return sendJson(res, 200, listProviderKeyIds(ownerId));
  if (p === '/api/auth/custom' && req.method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    if (!providerSpecs(ownerId)[body.providerId] || !String(body.key || '').trim()) return sendJson(res, 400, { error: 'providerId/key required' });
    setProviderKey(ownerId, body.providerId, String(body.key).trim());
    return sendJson(res, 200, { status: 'success' });
  }
  if (p === '/api/auth/custom' && req.method === 'DELETE') {
    const body = await readJson(req, 64 * 1024);
    deleteProviderKey(ownerId, body.providerId);
    return sendJson(res, 200, { status: 'success' });
  }
  const authProvider = /^\/api\/auth\/([^/]+)$/.exec(p);
  if (authProvider && !['custom','login','logout','register','me','change-password'].includes(authProvider[1])) {
    const providerId = decodePathPart(authProvider[1]);
    if (req.method === 'PUT') {
      if (!providerSpecs(ownerId)[providerId]) return sendJson(res, 404, { error: 'Unknown provider' });
      const body = await readJson(req, 128 * 1024);
      const key = body.key || body.apiKey;
      if (!key) return sendJson(res, 400, { error: 'key required' });
      setProviderKey(ownerId, providerId, String(key));
      return sendJson(res, 200, true);
    }
    if (req.method === 'DELETE') { deleteProviderKey(ownerId, providerId); return sendJson(res, 204, null); }
  }
  if (p === '/api/providers/models' && req.method === 'GET') return sendJson(res, 200, await buildCatalog(ownerId, { force: url.searchParams.get('refresh') === '1' }));

  // Workspace routes require a concrete owned session.
  if (p.startsWith('/api/workspace/') || p === '/api/file' || p.startsWith('/api/file/')) {
    const wsSid = url.searchParams.get('sessionId') || '';
    if (!wsSid || !ownsChat(wsSid, ownerId)) return sendJson(res, 404, { error: 'Session not found' });
    if (['PUT','POST'].includes(req.method || '') && String(req.headers['content-type'] || '').includes('application/json')) req.bodyJson = await readJson(req, MAX_JSON_BYTES);
    const handled = await handleWorkspace(req, res, wsSid, url);
    if (handled !== false) return;
  }

  // Маркер превью выдаётся только владельцу чата и только по его запросу.
  if (p === '/api/workspace/preview-token' && req.method === 'GET') {
    const psid = url.searchParams.get('sessionId') || '';
    if (!psid || !ownsChat(psid, ownerId)) return sendJson(res, 404, { error: 'Session not found' });
    const token = mintPreviewToken(ownerId, psid);
    if (!token) return sendJson(res, 404, { error: 'Session not found' });
    return sendJson(res, 200, { base: `/api/preview/${token}/~/` });
  }

  // Sandboxed file preview used by the right sidebar.
  const preview = /^\/api\/sandbox-proxy\/(ses_[A-Za-z0-9]+)\/~\/(.*)$/.exec(p);
  if (preview && req.method === 'GET') {
    const psid = preview[1];
    if (!ownsChat(psid, ownerId)) return sendJson(res, 404, { error: 'Not found' });
    return servePreviewFile(req, res, psid, preview[2]);
  }

  return sendJson(res, 404, { error: `Unknown route: ${req.method} ${p}` });
}

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

/**
 * Отдаёт один файл из воркспейса в панель превью. Общий хвост для двух
 * входов: по cookie (само приложение) и по маркеру в пути (iframe превью).
 * Права проверяет вызывающий; граница пути — всё та же safeWorkspacePath.
 */
function servePreviewFile(req, res, psid, rawRelative) {
  let relative;
  try { relative = rawRelative.split('/').map(decodeURIComponent).join('/'); }
  catch { return sendJson(res, 400, { error: 'Bad request' }); }
  const full = safeWorkspacePath(workspaceFor(psid), relative, { allowMissing: false });
  const st = fs.statSync(full);
  if (!st.isFile()) return sendJson(res, 404, { error: 'Not a file' });
  res.writeHead(200, {
    'content-type': mimeFor(full),
    'content-length': st.size,
    'content-security-policy': previewSecurityPolicy(req),
    'x-content-type-options': 'nosniff',
    // Маркер доступа лежит в пути, поэтому реферер наружу не отдаём.
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

/**
 * CSP для страницы из воркспейса, которую показывает панель превью.
 *
 * Превью открывается в iframe без `allow-same-origin`, то есть у документа
 * непрозрачный (opaque) origin. Для такого документа источник `'self'` не
 * совпадает ни с чем: прежняя политика `script-src 'self'` резала и встроенные
 * <script>, и соседние script.js/style.css. Страница загружалась, но оставалась
 * пустой — именно так выглядела игра, у которой не отрисовывалась доска.
 *
 * Поэтому вместо `'self'` подставляем конкретный origin сервера, а inline-код
 * разрешаем явно. Изоляция от приложения при этом остаётся: origin всё так же
 * opaque, доступа к cookie и DOM родителя у страницы нет, а сеть ограничена тем же
 * самым origin — выгрузить данные на чужой сервер страница не может.
 */
function previewSecurityPolicy(req) {
  const rawHost = String(req?.headers?.host || '').trim();
  const host = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(rawHost) ? rawHost : '';
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  // За прокси (как на бою) схему знает только заголовок; локально — сокет.
  const scheme = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : (req?.socket?.encrypted ? 'https' : 'http');
  const own = host ? `${scheme}://${host}` : '';
  // Без валидного Host остаётся только inline: подключить собственные файлы
  // страницы нечем, зато однофайловая страница всё равно работает.
  const from = own ? `${own} ` : '';
  return [
    "default-src 'none'",
    `script-src ${from}'unsafe-inline' 'unsafe-eval'`,
    `style-src ${from}'unsafe-inline'`,
    `img-src ${from}data: blob:`,
    `font-src ${from}data:`,
    `media-src ${from}data: blob:`,
    `connect-src ${from}data: blob:`,
    `worker-src ${from}blob:`,
    `frame-src ${from}data: blob:`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    `form-action ${own || "'none'"}`,
  ].join('; ');
}

function appSecurityHeaders(req) {
  const rawHost = String(req?.headers?.host || '').trim();
  // Same-host websocket sources keep the trusted self-hosted terminal working
  // without broad `ws:`/`wss:` CSP sources that would permit arbitrary egress.
  const host = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(rawHost) ? rawHost : '';
  const sockets = host ? ` ws://${host} wss://${host}` : '';
  // Browser telemetry is optional. Keep the exception narrow instead of
  // allowing arbitrary HTTPS exfiltration from an injected script. Operators
  // using a self-hosted Sentry origin should extend this policy explicitly.
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
  // A malformed percent-escape threw out of the request handler and killed the
  // response with a 500 (and an unhandled rejection in the logs).
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
    'cache-control': immutableAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    ...appSecurityHeaders(req),
  });
  fs.createReadStream(full).pipe(res);
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

async function shutdown(signal = 'SIGTERM') {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  DRAINING = true;
  console.log(`[shutdown] ${signal}: draining up to ${SHUTDOWN_GRACE_MS}ms (${activeTurnCount()} active turn(s))`);
  // Stop accepting new TCP connections immediately. Existing SSE/provider work
  // may finish while the agent's durable checkpoint remains recoverable.
  server.close();
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
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
