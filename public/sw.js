/**
 * Service worker для установки как приложение и работы офлайн.
 *
 * ВАЖНО про историю: раньше в проекте стоял VitePWA, который прекэшировал
 * index.html вместе с ассетами. После пересборки dist (в том числе после
 * обновления приложения) клиент продолжал получать старый index.html из кэша, а его
 * чанки с сервера уже исчезли — отсюда stale-бандл и ChunkLoadError. Поэтому
 * VitePWA убрали, а в main.tsx стоял killswitch, снимавший регистрацию.
 *
 * Здесь та же ошибка исключена по построению:
 *   1. HTML и навигации НИКОГДА не берутся из кэша, пока сеть доступна —
 *      значит новая сборка подхватывается сразу, как и без service worker'а.
 *      Кэш HTML не используется даже как fallback: устаревшая разметка тянула
 *      бы за собой несуществующие чанки. Офлайн отдаём отдельную страницу.
 *   2. Кэшируются только ассеты с хэшем в имени (/assets/…): они неизменяемы,
 *      поэтому cache-first безопасен, а новая сборка запрашивает новые имена.
 *   3. Всё под /api/ проходит мимо кэша целиком: там авторизация, SSE и
 *      данные пользователя, которым в кэше не место.
 *   4. При активации новой версии удаляются все кэши, кроме своих текущих, —
 *      это же чистит наследие старого workbox-кэша.
 */

const VERSION = "v1";
const ASSET_CACHE = `z-agent-assets-${VERSION}`;
const SHELL_CACHE = `z-agent-shell-${VERSION}`;
const KEEP_CACHES = new Set([ASSET_CACHE, SHELL_CACHE]);

const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

/** Пути, которые никогда не должны попадать в кэш. */
function isBypassed(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/socket.io/") ||
    url.pathname === "/health" ||
    url.pathname === "/metrics"
  );
}

/** Ассет с хэшем в имени — неизменяемый, его можно держать в кэше долго. */
function isHashedAsset(url) {
  return url.pathname.startsWith("/assets/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      // Отсутствие одного файла не должно ломать установку целиком.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) =>
            KEEP_CACHES.has(key) ? undefined : caches.delete(key),
          ),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url)) return;

  // Навигация: только сеть. Офлайн — отдельная страница, а не устаревший HTML.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then(
          (cached) =>
            cached ||
            new Response("Офлайн", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }),
        ),
      ),
    );
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches
              .open(ASSET_CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => undefined);
          }
          return response;
        });
      }),
    );
    return;
  }

  // Иконки, манифест и подобная мелочь: сеть с обновлением кэша, кэш —
  // страховка на случай офлайна.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches
            .open(SHELL_CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || Response.error()),
      ),
  );
});
