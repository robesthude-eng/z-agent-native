import { log } from "../lib/log";
import { eventUrl } from "./client";
import { eventSessionId, isAppEventShaped } from "./eventGuards";
import type { AppEvent } from "./types";

type Handler = (event: AppEvent) => void;

// Native runtime emits these as named SSE events (`event: <type>`).
// We register a listener for each so they are captured (EventSource only fires
// `onmessage` for unnamed events).
// P3: список вынесен в конфиг — по умолчанию используется DEFAULT_NAMED_TYPES,
// но EventStream принимает свой список третьим аргументом конструктора
// (новые типы runtime-событий можно подключить
// без правки этого файла).
const DEFAULT_NAMED_TYPES: readonly string[] = [
  "session.created",
  "session.updated",
  "session.removed",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.removed",
  "session.status",
  "session.idle",
  "permission.asked",
  "permission.responded",
  "question.asked",
  "question.replied",
  "question.rejected",
  // Файловые события нужны панели Workspace: без них новые файлы после
  // bash/scp/rsync видны только на следующем polling tick.
  "file.edited",
  "file.watcher.updated",
];

export type StreamStatus = "connecting" | "open" | "closed" | "idle";

// Module-level mirror of the latest EventStream status. The app runs a single
// EventStream instance (see router.tsx), so consumers outside React (e.g. the
// send() HTTP poller in messagesSlice) can cheaply ask "is SSE healthy now?".
let activeStreamStatus: StreamStatus = "closed";
export function getActiveStreamStatus(): StreamStatus {
  return activeStreamStatus;
}

// P2-fix: глобального статуса недостаточно — единственный EventStream
// подписан на события ОДНОЙ (активной) сессии. Для фоновой сессии
// SSE может быть «open», но её события в клиент не приходят. Поэтому
// здоровье SSE нужно спрашивать per-session: стрим открыт И подписан
// именно на эту сессию. Native runtime не предоставляет глобальную шину:
// null означает, что подключаться пока некуда.
let activeStreamSessionId: string | null = null;
export function isSseHealthyForSession(sessionId: string): boolean {
  return activeStreamStatus === "open" && activeStreamSessionId === sessionId;
}

export class EventStream {
  private es: EventSource | null = null;
  private handlers = new Set<Handler>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private sessionId: string | null;
  // The application stream is constructed before a chat is selected. In that
  // state /api/event has no valid session scope and the server correctly
  // rejects it, so wait instead of entering an endless 403 reconnect loop.
  private readonly requiresSession: boolean;
  // connect() may be called before a session exists. Remember that so
  // switchSession can open the stream instead of waiting for a listener.
  private connectRequested = false;
  private attempt = 0;
  private maxAttempts = 50; // после ~50 быстрых попыток — редкие ретраи раз в минуту
  // True after a real transport error — used to trigger a one-shot catch-up
  // refetch on the next successful open (SSE has no Last-Event-ID replay).
  private hadDrop = false;
  // Релиз 4: последний обработанный порядковый номер кадра (id: N от
  // прокси). Используется для дедупликации replay-повторов и для
  // ?lastEventId= при ручном реконнекте (новый EventSource сам
  // Last-Event-ID не посылает).
  private lastSeq: number | null = null;
  private lastEpoch: string | null = null;
  private lastEventId: string | null = null;
  // Должно соответствовать EVENT_RING_SIZE на сервере: повтор старее
  // этого окна — не replay, а сброс счётчика (рестарт сервера).
  private static readonly RING_REPLAY_WINDOW = 1000;
  private namedTypes: readonly string[];
  status: StreamStatus = "connecting";

  private setStatus(s: StreamStatus) {
    this.status = s;
    activeStreamStatus = s;
  }

  constructor(
    url?: string,
    sessionId?: string | null,
    namedTypes?: readonly string[],
  ) {
    this.sessionId = sessionId ?? null;
    this.requiresSession = url === undefined;
    activeStreamSessionId = this.sessionId;
    this.url = url ?? eventUrl(this.sessionId);
    this.namedTypes = namedTypes ?? DEFAULT_NAMED_TYPES;
    if (this.requiresSession && !this.sessionId) {
      this.setStatus("idle");
    }
  }

  /** Rebuild the URL with a fresh token (call after re-login). */
  updateToken() {
    // URL обновляем сразу — любой новый connect() уже пойдёт с свежим токеном.
    this.url = eventUrl(this.sessionId);
    // P1-fix: дебаунс переподключения — несколько подряд обновлений
    // токена (re-login, гонки рефреша в нескольких вкладках) больше
    // не рвут стрим на каждый вызов; пересоединяемся один раз
    // спустя 250 мс тишины.
    if (!this.es && !this.tokenRefreshDebounce) return;
    if (this.tokenRefreshDebounce) clearTimeout(this.tokenRefreshDebounce);
    this.tokenRefreshDebounce = setTimeout(() => {
      this.tokenRefreshDebounce = null;
      this.url = eventUrl(this.sessionId);
      if (this.es) {
        this.es.close();
        this.es = null;
      }
      this.attempt = 0;
      this.connect();
    }, 250);
  }

  /** Switch to a different session's event stream. */
  switchSession(sessionId: string | null) {
    // No-op when the session hasn't changed — avoids needless SSE reconnect
    // churn (each reconnect drops in-flight token events for a moment).
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    activeStreamSessionId = sessionId;
    this.url = eventUrl(sessionId);
    // Релиз 4: у другой сессии свой кольцевой буфер и своя нумерация.
    this.lastSeq = null;
    this.lastEpoch = null;
    this.lastEventId = null;
    this.attempt = 0;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    // Connect immediately if anyone is listening, or if connect() already ran
    // and was only waiting for a session id.
    if (this.connectRequested || this.handlers.size > 0) this.connect();
  }

  connect() {
    this.connectRequested = true;
    if (this.requiresSession && !this.sessionId) {
      // Welcome / new-chat: there is no session-scoped bus yet. This is not
      // a transport failure — the reconnect banner must stay hidden.
      this.setStatus("idle");
      return;
    }
    // P1-fix: защита от двойного вызова connect() — если соединение уже
    // открыто или открывается, не создаём параллельный EventSource
    // (двойная подписка = дубли событий и лишняя нагрузка на прокси).
    if (this.es && this.es.readyState !== EventSource.CLOSED) return;
    // Отменяем запланированный реконнект, чтобы его таймер не
    // породил второй connect() поверх только что созданного.
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.es) this.es.close();
    this.setStatus("connecting");
    try {
      // Релиз 4: при реконнекте просим у прокси replay пропущенных
      // кадров из кольцевого буфера (новый EventSource не шлёт
      // Last-Event-ID сам — передаём через query-параметр).
      const url =
        this.lastEventId === null
          ? this.url
          : `${this.url}${this.url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(this.lastEventId)}`;
      this.es = new EventSource(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.es.onopen = () => {
      const hadDrop = this.hadDrop;
      this.hadDrop = false;
      this.setStatus("open");
      this.attempt = 0; // reset backoff on successful connection
      // P1-fix: SSE не докидывает пропущенные во время разрыва события —
      // после реального дропа шлём синтетическое событие, по которому
      // стор один раз дотягивает историю активной сессии.
      if (hadDrop) {
        const ev: AppEvent = {
          type: "stream.reconnected",
          properties: {},
        };
        this.emit(ev);
      }
    };
    this.es.onerror = () => {
      // Mobile Chrome fires onerror while the handshake is still CONNECTING
      // (slow 4G, first byte delayed). Closing here aborts a stream that
      // would have opened — Caddy then logs "context canceled" in 1–3ms
      // and we flap. Let the native EventSource finish that attempt.
      if (this.es && this.es.readyState === EventSource.CONNECTING) return;
      this.hadDrop = true;
      this.setStatus("closed");
      this.es?.close();
      // P1-fix: обнуляем ссылку ДО планирования реконнекта, иначе
      // guard в connect() (`es && readyState !== CLOSED`) увидит
      // ещё не-CLOSED (в настоящем EventSource после ошибки состояние
      // может быть CONNECTING) и early-return'ит — второй EventSource
      // не создастся, реконнект «теряется».
      this.es = null;
      this.scheduleReconnect();
    };

    this.es.onmessage = (m) => this.dispatch("message", m.data, m.lastEventId);
    for (const t of this.namedTypes) {
      this.es.addEventListener(t, ((e: MessageEvent) =>
        this.dispatch(t, e.data, e.lastEventId)) as EventListener);
    }
  }

  private dispatch(namedType: string, rawData: string, eventId?: string) {
    // Релиз 4: прокси нумерует кадры монотонным id. Повтор (replay по
    // Last-Event-ID) отбрасываем — обработка становится идемпотентной
    // на уровне транспорта (включая append-дельты). Дырка в нумерации
    // или сброс счётчика (рестарт сервера) — один раз дотягиваем
    // историю через stream.reconnected. Внутри одного TCP-соединения SSE
    // упорядочен, поэтому буферизация «не по порядку» не требуется.
    const rawEventId = eventId ?? "";
    const match = /^([^:]+):(\d+)$/.exec(rawEventId);
    const epoch = match?.[1] ?? null;
    const seq = Number.parseInt(match?.[2] ?? rawEventId, 10);
    if (Number.isFinite(seq)) {
      if (epoch && this.lastEpoch && epoch !== this.lastEpoch) {
        // New server process: its sequence legitimately starts near zero.
        // Accept the frame and force one authoritative history catch-up.
        this.lastEpoch = epoch;
        this.lastSeq = seq;
        this.lastEventId = rawEventId;
        this.emit({ type: "stream.reconnected", properties: {} });
      } else if (this.lastSeq !== null && seq <= this.lastSeq) {
        if (this.lastSeq - seq < EventStream.RING_REPLAY_WINDOW) return;
        // Legacy numeric ids have no epoch. Keep the old large-rollback
        // recovery path for compatibility with an older server.
        this.lastSeq = seq;
        this.lastEpoch = epoch;
        this.lastEventId = rawEventId;
        this.emit({
          type: "stream.reconnected",
          properties: {},
        });
      } else {
        const gap = this.lastSeq !== null && seq > this.lastSeq + 1;
        this.lastSeq = seq;
        this.lastEpoch = epoch;
        this.lastEventId = rawEventId;
        if (gap) {
          this.emit({
            type: "stream.reconnected",
            properties: {},
          });
        }
      }
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawData);
    } catch {
      // P0-fix: битый чанк не маскируем под нормальное событие —
      // шлём выделенное stream.corrupted, по которому стор покажет
      // плашку «Стрим прерван» вместо непредсказуемой обработки
      // сырой строки всеми обработчиками.
      const ev: AppEvent = {
        type: "stream.corrupted",
        properties: { raw: rawData, sourceType: namedType },
      };
      this.emit(ev);
      return;
    }
    let ev: AppEvent = isAppEventShaped(parsed)
      ? parsed
      : { type: namedType, properties: parsed };
    // Часть workspace-scoped событий runtime (в частности file watcher) не
    // несёт sessionID в payload. Наш EventStream уже привязан к конкретной
    // сессии, поэтому добавляем routing-context перед передачей в store.
    if (this.sessionId && !eventSessionId(ev.properties)) {
      ev = {
        ...ev,
        properties: { ...ev.properties, sessionID: this.sessionId },
      };
    }
    // Debug logging disabled in production — enable via localStorage.setItem("z_agent_debug", "1")
    if (
      typeof window !== "undefined" &&
      localStorage.getItem("z_agent_debug") === "1"
    ) {
      log.debug("[SSE] event:", namedType, "data:", parsed, "ev:", ev);
    }
    this.emit(ev);
  }

  // P0-fix: исключение в одном подписчике не должно прерывать доставку
  // события остальным и ломать жизненный цикл подключения
  // (бросок из onopen/onmessage). Ошибку логируем и продолжаем.
  private emit(ev: AppEvent) {
    for (const h of this.handlers) {
      try {
        h(ev);
      } catch (err) {
        log.error("[SSE] handler error for event:", ev.type, err);
      }
    }
  }

  private scheduleReconnect() {
    if (this.retry) return;
    // P1-fix: после исчерпания быстрого экспоненциального бэкоффа
    // не сдаёмся навсегда (раньше вкладка оставалась «мёртвой» до
    // ручной перезагрузки) — переходим на редкие попытки раз в
    // минуту, пока сервер не вернётся.
    let delay: number;
    if (this.attempt >= this.maxAttempts) {
      log.warn(
        "[SSE] Max fast reconnect attempts reached. Retrying every 60s.",
      );
      delay = 60000;
    } else {
      // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s.
      delay = Math.min(1000 * 2 ** this.attempt++, 30000);
    }
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    if (!this.es) this.connect();
    return () => this.handlers.delete(handler);
  }

  /** Reset backoff and reconnect immediately (call on window online/focus). */
  wake() {
    this.attempt = 0;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.status !== "open" && this.handlers.size > 0) this.connect();
  }

  close() {
    if (this.retry) clearTimeout(this.retry);
    if (this.tokenRefreshDebounce) {
      clearTimeout(this.tokenRefreshDebounce);
      this.tokenRefreshDebounce = null;
    }
    this.es?.close();
    this.es = null;
    this.setStatus("closed");
  }
}
