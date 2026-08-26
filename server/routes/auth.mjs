import { readJson, sendJson } from '../native/json.mjs';
import {
  authFromRequest, changePassword, checkCsrf, clearCookies, issueLogin,
  loginUser, logoutToken, registerUser, requireAuth,
} from '../native/auth.mjs';
import { TRUST_PROXY } from '../native/config.mjs';
import { authRateLimitExceeded, recordAuthFailures } from '../native/store.mjs';

const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_IP_MAX_FAILURES = 40;
const AUTH_ACCOUNT_MAX_FAILURES = 15;

export function authRemoteAddress(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket?.remoteAddress || 'unknown');
}

export function authIpBucket(req) {
  return `ip:${authRemoteAddress(req)}`;
}

export function authAccountBucket(email) {
  return `account:${String(email || '').trim().toLowerCase()}`;
}

export function checkAuthRate(req, email) {
  const buckets = [authIpBucket(req)];
  const acc = authAccountBucket(email);
  if (acc !== 'account:') buckets.push(acc);
  return !authRateLimitExceeded(buckets, {
    [authIpBucket(req)]: AUTH_IP_MAX_FAILURES,
    default: AUTH_ACCOUNT_MAX_FAILURES,
  });
}

export function noteAuthFailure(req, email) {
  const buckets = [authIpBucket(req)];
  const acc = authAccountBucket(email);
  if (acc !== 'account:') buckets.push(acc);
  recordAuthFailures(buckets, { windowMs: AUTH_WINDOW_MS });
}

export async function handleAuthRoutes(req, res, p) {
  if (p === '/api/auth/register' && req.method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    if (!checkAuthRate(req, body.email)) {
      sendJson(res, 429, { error: 'Слишком много попыток. Повторите позже.' });
      return true;
    }
    let user;
    try { user = registerUser(body.email, body.password, body.inviteCode); }
    catch (error) { noteAuthFailure(req, body.email); throw error; }
    const login = issueLogin(user.email);
    sendJson(res, 200, { status: 'success', user: { email: user.email, role: user.role } }, { 'set-cookie': login.cookies });
    return true;
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    if (!checkAuthRate(req, body.email)) {
      sendJson(res, 429, { error: 'Слишком много попыток. Повторите позже.' });
      return true;
    }
    let user;
    try { user = loginUser(body.email, body.password); }
    catch (error) { noteAuthFailure(req, body.email); throw error; }
    const login = issueLogin(user.email);
    sendJson(res, 200, { status: 'success', user: { email: user.email, role: user.role } }, { 'set-cookie': login.cookies });
    return true;
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const auth = authFromRequest(req);
    if (auth) {
      sendJson(res, 200, { status: 'success', user: { email: auth.user.email, role: auth.user.role } });
    } else {
      sendJson(res, 401, { error: 'Unauthorized' });
    }
    return true;
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const auth = authFromRequest(req);
    if (auth && !checkCsrf(req, res, auth)) return true;
    if (auth) logoutToken(auth.token);
    sendJson(res, 200, { status: 'success' }, { 'set-cookie': clearCookies() });
    return true;
  }

  if (p === '/api/auth/change-password' && req.method === 'POST') {
    const auth = requireAuth(req, res);
    if (!auth) return true;
    if (!checkCsrf(req, res, auth)) return true;
    const ownerId = auth.user.email;
    const body = await readJson(req, 64 * 1024);
    const revokedSessions = changePassword(ownerId, body.currentPassword, body.newPassword, auth.token);
    sendJson(res, 200, { status: 'success', revokedSessions });
    return true;
  }

  return false;
}
