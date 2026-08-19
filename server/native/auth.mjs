import crypto from 'node:crypto';
import { ALLOW_OPEN_REGISTRATION, INVITE_CODE, SECURE_COOKIES, SESSION_TTL_MS } from './config.mjs';
import {
  createAuthSession, createUser, deleteAuthSession, deleteOtherAuthSessions,
  getAuthSession, getUser, pruneAuthSessions, updatePassword, userCount,
} from './store.mjs';

const SESSION_COOKIE = 'z_agent_session';
const CSRF_COOKIE = 'z_agent_csrf';

function b64url(buffer) { return Buffer.from(buffer).toString('base64url'); }
function unb64(value) { return Buffer.from(value, 'base64url'); }

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${b64url(salt)}$${b64url(key)}`;
}

export function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith('scrypt$')) return false;
  const [, saltText, keyText] = encoded.split('$');
  if (!saltText || !keyText) return false;
  const expected = unb64(keyText);
  const actual = crypto.scryptSync(String(password), unb64(saltText), expected.length, { N: 16384, r: 8, p: 1 });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); }
      catch { /* malformed cookies are ignored instead of turning auth into 500 */ }
    }
  }
  return out;
}

function cookie(name, value, { httpOnly = true, maxAge = SESSION_TTL_MS } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`];
  if (httpOnly) attrs.push('HttpOnly');
  if (SECURE_COOKIES) attrs.push('Secure');
  return attrs.join('; ');
}

export function issueLogin(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  createAuthSession(token, email);
  return {
    token,
    csrf,
    cookies: [cookie(SESSION_COOKIE, token), cookie(CSRF_COOKIE, csrf, { httpOnly: false })],
  };
}

export function clearCookies() {
  return [cookie(SESSION_COOKIE, '', { maxAge: 0 }), cookie(CSRF_COOKIE, '', { maxAge: 0, httpOnly: false })];
}

// Expired-session cleanup is a full table scan; once a minute is plenty and
// keeps it off the hot path of every request (including static assets).
const PRUNE_INTERVAL_MS = 60_000;
let lastPruneAt = 0;

function pruneExpiredSessions(now = Date.now()) {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  pruneAuthSessions(now - SESSION_TTL_MS);
}

export function authFromRequest(req) {
  pruneExpiredSessions();
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = getAuthSession(token);
  if (!session || Date.now() - session.created_at > SESSION_TTL_MS) return null;
  const user = getUser(session.email);
  return user ? { user, token } : null;
}

export function requireAuth(req, res) {
  const auth = authFromRequest(req);
  if (auth) return auth;
  const body = JSON.stringify({ error: 'Unauthorized' });
  res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return null;
}

export function checkCsrf(req, res) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET')) return true;
  const url = String(req.url || '');
  if (/\/api\/auth\/(login|register)$/.test(url.split('?')[0])) return true;
  const cookies = parseCookies(req);
  const header = req.headers['x-csrf-token'];
  const ok = typeof header === 'string' && header.length >= 16 && cookies[CSRF_COOKIE] === header;
  if (ok) return true;
  const body = JSON.stringify({ error: 'CSRF validation failed' });
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return false;
}

export function registerUser(email, password, inviteCode = '') {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean.includes('@') || String(password || '').length < 6) throw Object.assign(new Error('Введите корректный email и пароль минимум из 6 символов.'), { statusCode: 400 });
  const bootstrap = userCount() === 0;
  // Fail closed: only the very first (admin) account may be created without an
  // invite code. Public registration must be enabled explicitly.
  if (!bootstrap && !INVITE_CODE && !ALLOW_OPEN_REGISTRATION) {
    throw Object.assign(new Error('Регистрация закрыта. Обратитесь к администратору за кодом приглашения.'), { statusCode: 403 });
  }
  if (INVITE_CODE && inviteCode !== INVITE_CODE) throw Object.assign(new Error('Неверный код приглашения.'), { statusCode: 403 });
  if (getUser(clean)) throw Object.assign(new Error('Пользователь уже существует.'), { statusCode: 409 });
  const role = bootstrap ? 'admin' : 'user';
  createUser(clean, hashPassword(password), role);
  return getUser(clean);
}

export function loginUser(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  const user = getUser(clean);
  if (!user || !verifyPassword(password || '', user.password_hash)) throw Object.assign(new Error('Неверный email или пароль.'), { statusCode: 401 });
  return user;
}

export function logoutToken(token) { if (token) deleteAuthSession(token); }

export function changePassword(email, currentPassword, newPassword, keepToken) {
  const user = getUser(email);
  if (!user || !verifyPassword(currentPassword || '', user.password_hash)) throw Object.assign(new Error('Текущий пароль неверен.'), { statusCode: 400 });
  if (String(newPassword || '').length < 6) throw Object.assign(new Error('Новый пароль должен содержать минимум 6 символов.'), { statusCode: 400 });
  updatePassword(email, hashPassword(newPassword));
  return deleteOtherAuthSessions(email, keepToken);
}
