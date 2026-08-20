import crypto from 'node:crypto';
import { ALLOW_OPEN_REGISTRATION, INVITE_CODE, SECURE_COOKIES, SESSION_TTL_MS } from './config.mjs';
import {
  createAuthSession, createRegistrationUser, deleteAuthSession,
  getAuthSession, getUser, pruneAuthSessions, updatePassword, updatePasswordAndRevokeSessions, userCount,
} from './store.mjs';

const SESSION_COOKIE = SECURE_COOKIES ? '__Host-z_agent_session' : 'z_agent_session';
const CSRF_COOKIE = SECURE_COOKIES ? '__Host-z_agent_csrf' : 'z_agent_csrf';

function b64url(buffer) { return Buffer.from(buffer).toString('base64url'); }
function unb64(value) { return Buffer.from(value, 'base64url'); }

// Comparing tokens with === leaks their prefix through response timing.
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const PASSWORD_SCHEME = 'scrypt';
const PASSWORD_VERSION = 'v2';
const PASSWORD_SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
const LEGACY_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64, PASSWORD_SCRYPT);
  return `${PASSWORD_SCHEME}$${PASSWORD_VERSION}$${PASSWORD_SCRYPT.N}$${PASSWORD_SCRYPT.r}$${PASSWORD_SCRYPT.p}$${b64url(salt)}$${b64url(key)}`;
}

function passwordHashParams(encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith(`${PASSWORD_SCHEME}$`)) return null;
  const parts = encoded.split('$');
  if (parts.length === 3) {
    const [, saltText, keyText] = parts;
    return { version: 'v1', ...LEGACY_SCRYPT, saltText, keyText };
  }
  if (parts.length !== 7 || parts[1] !== PASSWORD_VERSION) return null;
  const N = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 16384 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  // maxmem is deliberately bounded independently of values stored in the DB so
  // a corrupt/malicious password_hash row cannot turn login into memory DoS.
  const required = 128 * N * r + 16 * 1024 * 1024;
  if (required > 128 * 1024 * 1024) return null;
  return { version: parts[1], N, r, p, maxmem: Math.max(64 * 1024 * 1024, required), saltText: parts[5], keyText: parts[6] };
}

export function passwordHashNeedsUpgrade(encoded) {
  const params = passwordHashParams(encoded);
  return !params || params.version !== PASSWORD_VERSION || params.N < PASSWORD_SCRYPT.N || params.r < PASSWORD_SCRYPT.r || params.p < PASSWORD_SCRYPT.p;
}

export function verifyPassword(password, encoded) {
  const params = passwordHashParams(encoded);
  if (!params?.saltText || !params?.keyText) return false;
  try {
    const expected = unb64(params.keyText);
    if (expected.length < 32 || expected.length > 128) return false;
    const salt = unb64(params.saltText);
    if (salt.length < 16 || salt.length > 64) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
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
  createAuthSession(token, email, csrf);
  const cookies = [cookie(SESSION_COOKIE, token), cookie(CSRF_COOKIE, csrf, { httpOnly: false })];
  if (SECURE_COOKIES) {
    cookies.push(cookie('z_agent_session', '', { maxAge: 0 }), cookie('z_agent_csrf', '', { maxAge: 0, httpOnly: false }));
  }
  return { token, csrf, cookies };
}

export function clearCookies() {
  const out = [cookie(SESSION_COOKIE, '', { maxAge: 0 }), cookie(CSRF_COOKIE, '', { maxAge: 0, httpOnly: false })];
  if (SECURE_COOKIES) {
    out.push(cookie('z_agent_session', '', { maxAge: 0 }), cookie('z_agent_csrf', '', { maxAge: 0, httpOnly: false }));
  }
  return out;
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
  return user ? { user, token, session } : null;
}

export function requireAuth(req, res) {
  const auth = authFromRequest(req);
  if (auth) return auth;
  const body = JSON.stringify({ error: 'Unauthorized' });
  res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return null;
}

export function checkCsrf(req, res, auth = null) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET')) return true;
  const url = String(req.url || '');
  if (/\/api\/auth\/(login|register)$/.test(url.split('?')[0])) return true;
  const cookies = parseCookies(req);
  const header = req.headers['x-csrf-token'];
  const cookieToken = cookies[CSRF_COOKIE] || cookies['z_agent_csrf'] || cookies['__Host-z_agent_csrf'] || '';
  let ok = typeof header === 'string' && header.length >= 16 && safeEqual(cookieToken, header);
  // Double submit on its own only proves the caller could write a cookie for
  // this site — a sibling subdomain, or XSS on one, can do exactly that, and
  // the pair was never tied to the logged-in session. Match the header against
  // the token stored on the session row too. Sessions created before that
  // column existed have no stored token and keep the old behaviour.
  const issued = auth?.session?.csrf;
  if (ok && typeof issued === 'string' && issued) ok = safeEqual(issued, header);
  if (ok) return true;
  const body = JSON.stringify({ error: 'CSRF validation failed' });
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return false;
}

export function registerUser(email, password, inviteCode = '') {
  const clean = String(email || '').trim().toLowerCase();
  const passwordText = String(password || '');
  if (!clean.includes('@') || passwordText.length < 12) throw Object.assign(new Error('Введите корректный email и пароль минимум из 12 символов.'), { statusCode: 400 });
  const bootstrapHint = userCount() === 0;
  // Fast-fail the normal closed-registration path, then repeat the authorization
  // decision inside an IMMEDIATE SQLite transaction. The second check is what
  // prevents two concurrent first registrations from both becoming admin.
  if (!bootstrapHint && !INVITE_CODE && !ALLOW_OPEN_REGISTRATION) {
    throw Object.assign(new Error('Регистрация закрыта. Обратитесь к администратору за кодом приглашения.'), { statusCode: 403 });
  }
  if (INVITE_CODE && inviteCode !== INVITE_CODE) throw Object.assign(new Error('Неверный код приглашения.'), { statusCode: 403 });
  if (getUser(clean)) throw Object.assign(new Error('Пользователь уже существует.'), { statusCode: 409 });
  const result = createRegistrationUser(clean, hashPassword(passwordText), { allowAdditional: Boolean(INVITE_CODE || ALLOW_OPEN_REGISTRATION) });
  if (result.status === 'closed') throw Object.assign(new Error('Регистрация закрыта. Обратитесь к администратору за кодом приглашения.'), { statusCode: 403 });
  if (result.status === 'exists') throw Object.assign(new Error('Пользователь уже существует.'), { statusCode: 409 });
  return getUser(clean);
}

export function loginUser(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  const user = getUser(clean);
  if (!user || !verifyPassword(password || '', user.password_hash)) throw Object.assign(new Error('Неверный email или пароль.'), { statusCode: 401 });
  // Opportunistic rehash keeps long-lived self-hosted accounts on the current
  // password KDF without forcing a fleet-wide reset. Verification happens
  // first, so only the legitimate password can trigger migration.
  if (passwordHashNeedsUpgrade(user.password_hash)) updatePassword(clean, hashPassword(password));
  return getUser(clean) || user;
}

export function logoutToken(token) { if (token) deleteAuthSession(token); }

export function changePassword(email, currentPassword, newPassword, keepToken) {
  const user = getUser(email);
  if (!user || !verifyPassword(currentPassword || '', user.password_hash)) throw Object.assign(new Error('Текущий пароль неверен.'), { statusCode: 400 });
  if (String(newPassword || '').length < 12) throw Object.assign(new Error('Новый пароль должен содержать минимум 12 символов.'), { statusCode: 400 });
  return updatePasswordAndRevokeSessions(email, hashPassword(newPassword), keepToken);
}
