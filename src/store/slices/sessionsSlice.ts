import { abortSessionRequests } from "../../api/abortRegistry";
import {
  api,
  isSessionDead,
  markSessionDead,
  SessionGoneError,
  unmarkSessionDead,
} from "../../api/client";
import type { SessionInfo, SessionStatus } from "../../api/types";
import { isTmpSession } from "../../lib/ids";
import { log } from "../../lib/log";
import { normalizeMessages } from "../helpers";
import { sessionFsm } from "../sessionFsm";
import type { SessionsSlice, Slice } from "../types";
import { byUpdated } from "../types";

// Prevent concurrent optimistic session creation from rapid "New chat" clicks.
let creatingSession = false;

// Settles when the in-flight newSession() finishes: either the real session
// id is already in the store or the optimistic tmp_ session was rolled back.
// send() awaits this event instead of napping a fixed 300ms and hoping the
// backend is fast enough.
let sessionCreationSettled: Promise<void> = Promise.resolve();

/** Wait until the in-flight optimistic session creation (if any) settles. */
export function waitForSessionCreation(): Promise<void> {
  return sessionCreationSettled;
}

// UX-fix: чтобы React StrictMode / URL-effect не делали 3 select() подряд
// с уходом в сеть, помним какие sid мы уже начинали проверять.
// Комбо с __deadSessions в client.ts подавляет повторные запросы к удалённой сессии.
const __pendingSelect = new Set<string>();
function _cleanupGhostFromURL(sid: string) {
  if (typeof window === "undefined") return;
  if (window.location.pathname.includes(sid)) {
    window.history.replaceState({}, "", "/");
  }
}

export const createSessionsSlice: Slice<SessionsSlice> = (set, get) => ({
  sessions: [],
  currentID: null,
  status: {},
  permissions: [],
  connection: "connecting",
  serverConnected: null,
  loading: false,
  error: null,
  sessionError: false,

  loadSessions: async () => {
    try {
      const sessions = (await api.listSessions()).sort(byUpdated);
      set({ sessions, sessionError: false, error: null });
    } catch {
      set({ sessionError: true });
    }
  },

  select: async (id) => {
    // UX-fix: если sid уже в blacklist (сервер подтвердил отсутствие сессии) —
    // не идём в сеть повторно. Просто чистим URL и переключаемся на первую живую.
    if (id && isSessionDead(id)) {
      log.warn("[select] sid уже помечен dead, пропускаем сетевой вызов:", id);
      set((state) => {
        const messages = { ...state.messages };
        delete messages[id];
        const remaining = state.sessions.filter((x) => x.id !== id);
        const nextId = remaining[0]?.id ?? null;
        return { sessions: remaining, messages, currentID: nextId };
      });
      _cleanupGhostFromURL(id);
      return;
    }

    // UX-fix: защита от React StrictMode double-invoke и от URL↔store loop —
    // если select(id) уже в полёте, не запускаем второй параллельно.
    if (id && __pendingSelect.has(id)) {
      set({ currentID: id });
      return;
    }
    if (id) __pendingSelect.add(id);

    set({ currentID: id });
    if (!id) return;
    try {
      const msgs = normalizeMessages(await api.listMessages(id));
      set((s) => ({ messages: { ...s.messages, [id]: msgs } }));
    } catch (e) {
      // UX-fix: если сессия мёртвая — убираем её из стора и переключаемся
      if (e instanceof SessionGoneError) {
        log.warn("[select] session gone, cleaning up:", id);
        set((state) => {
          const messages = { ...state.messages };
          delete messages[id];
          const remaining = state.sessions.filter((x) => x.id !== id);
          const nextId = remaining[0]?.id ?? null;
          return {
            sessions: remaining,
            messages,
            currentID: nextId,
          };
        });
        _cleanupGhostFromURL(id);
      }
    } finally {
      if (id) __pendingSelect.delete(id);
    }
  },

  // Кнопка «Новый чат» больше НЕ ходит на сервер.
  //
  // Здесь же держится старое правило: никакого переиспользования «пустых»
  // сессий. После перезагрузки страницы messages не подгружены ни для одной
  // сессии, поэтому пустой выглядела любая старая, и «Новый чат» молча
  // открывал чужой чат.
  //
  // Создание сессии на бэкенде поднимает контейнер-раннер, и раньше первое
  // сообщение ждало этого поднятия. Пока пользователь набирает текст, ждать
  // нечего: сессия материализуется при отправке (materializeSession), а
  // остаток поднятия прячется за задержкой самой модели.
  //
  // Побочный эффект намеренный: чат, в который ничего не написали, не доживает
  // до перезагрузки страницы и не оставляет за собой контейнер. Так же ведут
  // себя Claude и ChatGPT.
  newSession: async () => {
    if (creatingSession) return;
    const tempId = `tmp_${Date.now()}`;
    const tempSession: SessionInfo = {
      id: tempId,
      title: "New chat",
      time: { created: Date.now(), updated: Date.now() },
    };

    set((s) => ({
      sessions: [tempSession, ...s.sessions].sort(byUpdated),
      currentID: tempId,
      messages: { ...s.messages, [tempId]: [] },
      status: { ...s.status, [tempId]: "idle" as SessionStatus },
    }));
  },

  materializeSession: async () => {
    const tempId = get().currentID;
    if (!tempId || !isTmpSession(tempId)) return;
    if (creatingSession) {
      // Материализация уже идёт (двойной клик, гонка send/автосохранение) —
      // ждём её, а не запускаем вторую: иначе получим два чата на один tmp_.
      await sessionCreationSettled;
      return;
    }
    creatingSession = true;
    const creation = (async () => {
      // Настоящее создание на бэкенде: пустой воркспейс и свой контейнер.
      const session = await api.createSession();
      set((s) => {
        // Replace temp session with real one
        const filtered = s.sessions.filter((x) => x.id !== tempId);
        const msgs = { ...s.messages };
        const tempMsgs = msgs[tempId] || [];
        delete msgs[tempId];
        msgs[session.id] = tempMsgs;
        const st = { ...s.status };
        const tempStatus = st[tempId];
        delete st[tempId];
        if (tempStatus) st[session.id] = tempStatus;
        return {
          sessions: [session, ...filtered].sort(byUpdated),
          currentID: session.id,
          messages: msgs,
          status: st,
        };
      });
    })();
    sessionCreationSettled = creation;

    try {
      await creation;
    } catch (e) {
      // Rollback optimistic on error
      set((s) => ({
        sessions: s.sessions.filter((x) => x.id !== tempId),
        currentID: s.sessions.find((x) => x.id !== tempId)?.id || null,
        error: (e as Error).message,
      }));
      // The caller must stop. Swallowing this error let send() read the
      // fallback currentID and deliver the new prompt into an older chat.
      throw e;
    } finally {
      creatingSession = false;
      if (sessionCreationSettled === creation) sessionCreationSettled = Promise.resolve();
    }
  },

  // Claude-like delete: delete everything - messages, files, workspace, no recovery
  removeSession: async (id) => {
    // Cancel any in-flight requests and mark the session as dead so that
    // stale SSE / polling / select() calls are suppressed immediately.
    abortSessionRequests(id);
    markSessionDead(id);

    // Optimistic delete like Claude — immediately remove from UI.
    // Релиз 4: снимаем только удаляемую сессию, а не целые коллекции —
    // откат не должен затирать сессии/сообщения, пришедшие по SSE
    // за время ожидания ответа сервера.
    const removedSession = get().sessions.find((x) => x.id === id);
    const removedMessages = get().messages[id];
    const wasCurrent = get().currentID === id;

    set((s) => {
      const messages = { ...s.messages };
      delete messages[id];
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        messages,
        currentID: s.currentID === id ? null : s.currentID,
      };
    });

    try {
      await api.deleteSession(id);
      // Backend deletes:
      // - /app/workspace/sessions/{id} (workspace + uploads)
      // - /app/workspace/uploads/{id} (old path)
      // - ownership record
      // - runtime storage (messages, metadata)
      // So like Claude, everything is gone — no overlap, no leftover files

    } catch (e) {
      unmarkSessionDead(id);
      // Rollback on error — функциональная форма: возвращаем только
      // удалённую сессию, не трогая остальное текущее состояние.
      set((s) => ({
        sessions:
          removedSession && !s.sessions.some((x) => x.id === id)
            ? [...s.sessions, removedSession].sort(byUpdated)
            : s.sessions,
        messages:
          removedMessages !== undefined && !(id in s.messages)
            ? { ...s.messages, [id]: removedMessages }
            : s.messages,
        currentID: wasCurrent && s.currentID === null ? id : s.currentID,
        error: (e as Error).message,
      }));
    }
  },

  abort: async () => {
    const sid = get().currentID;
    if (!sid || isTmpSession(sid)) return;
    // Релиз 4: централизованная отмена — обрываем и локальные HTTP-запросы
    // этой сессии (висящий promptWithParts), не только серверную генерацию.
    abortSessionRequests(sid);
    try {
      await api.abortSession(sid);
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // Stale permission events from older runtimes are local compatibility data.
  // The native server has no browser permission-response endpoint, so discard
  // the card without issuing a guaranteed 404 request.
  respondPermission: async (permissionId, response) => {
    const req = get().permissions.find((p) => p.id === permissionId);
    if (!req) return;
    set((s) => ({
      permissions: s.permissions.filter((p) => p.id !== permissionId),
    }));
    void response;
  },

  setConnection: (connection) => set({ connection }),

  checkConnection: async () => {
    try {
      await api.health();
      set({ serverConnected: true });
    } catch {
      set({ serverConnected: false });
    }
  },
});
