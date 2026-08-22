import crypto from 'node:crypto';

/**
 * Маркеры доступа к файлам превью.
 *
 * Превью открывается в iframe без `allow-same-origin`, значит у документа
 * непрозрачный origin. Браузер считает запросы из такого документа
 * межсайтовыми и не прикладывает к ним куку SameSite=Lax. Сама страница
 * ещё загружается (переход инициирует приложение), а вот соседние style.css
 * и script.js уходят без авторизации и получают 404 — многофайловая
 * страница показывалась без стилей и без скриптов.
 *
 * Поэтому право читать файлы подтверждает маркер в ПУТИ, а не в query:
 * относительные ссылки внутри страницы наследуют его автоматически, а
 * query-параметр при разборе `href="style.css"` теряется.
 *
 * Границы этого ключа:
 * - живёт только в памяти процесса и умирает вместе с перезапуском;
 * - хранится в виде sha256, так что дамп памяти не даёт готового ключа;
 * - привязан к паре (владелец, чат) и даёт только чтение этого воркспейса;
 * - права проверяются ещё раз при каждой выдаче файла, поэтому удалённый
 *   чат перестаёт отдаваться сразу, без ожидания истечения срока.
 */

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TOKENS = 500;

/** sha256(маркер) -> { ownerId, sessionId, key, expiresAt } */
const byHash = new Map();
/** ownerId + \0 + sessionId -> { token, hash } */
const bySession = new Map();

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function drop(hash) {
  const entry = byHash.get(hash);
  if (!entry) return;
  byHash.delete(hash);
  const live = bySession.get(entry.key);
  if (live && live.hash === hash) bySession.delete(entry.key);
}

function prune(now) {
  for (const [hash, entry] of byHash) {
    if (entry.expiresAt <= now) drop(hash);
  }
}

/**
 * Выдаёт маркер для чата. Повторное открытие панели не плодит ключи:
 * пока прежний жив, возвращается он же с продлённым сроком.
 */
export function mintPreviewToken(ownerId, sessionId) {
  const owner = String(ownerId || '');
  const chat = String(sessionId || '');
  if (!owner || !chat) return null;
  const now = Date.now();
  prune(now);
  const key = `${owner}\u0000${chat}`;
  const live = bySession.get(key);
  if (live) {
    const entry = byHash.get(live.hash);
    if (entry && entry.expiresAt > now) {
      entry.expiresAt = now + TTL_MS;
      return live.token;
    }
    bySession.delete(key);
  }
  // Map хранит порядок вставки, поэтому первым уходит самый старый ключ.
  while (byHash.size >= MAX_TOKENS) {
    const oldest = byHash.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const hash = hashOf(token);
  byHash.set(hash, { ownerId: owner, sessionId: chat, key, expiresAt: now + TTL_MS });
  bySession.set(key, { token, hash });
  return token;
}

/** Возвращает { ownerId, sessionId } или null. Права на чат проверяет вызывающий. */
export function resolvePreviewToken(token) {
  const raw = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(raw)) return null;
  const hash = hashOf(raw);
  const entry = byHash.get(hash);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    drop(hash);
    return null;
  }
  return { ownerId: entry.ownerId, sessionId: entry.sessionId };
}

/** Гасит маркеры чата — например, при его удалении. */
export function revokePreviewTokens(sessionId) {
  const chat = String(sessionId || '');
  if (!chat) return 0;
  let removed = 0;
  for (const [hash, entry] of [...byHash]) {
    if (entry.sessionId !== chat) continue;
    drop(hash);
    removed += 1;
  }
  return removed;
}

/** Только для тестов и метрик. */
export function previewTokenCount() {
  prune(Date.now());
  return byHash.size;
}
