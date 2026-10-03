import { t } from "@/i18n";
import { abortSessionRequests } from "../../api/abortRegistry";
import {
  api,
  isSessionDead,
  markSessionDead,
  markSessionDeleted,
  SessionGoneError,
  unmarkSessionDead,
  unmarkSessionDeleted,
  wasSessionDeleted,
} from "../../api/client";
import type { SessionInfo, SessionStatus } from "../../api/types";
import { isTmpSession } from "../../lib/ids";
import { log } from "../../lib/log";
import { normalizeMessages } from "../helpers";
import type { ForkOutcome, SessionsSlice, Slice } from "../types";
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

/** Пустой оптимистичный чат: «Новый чат», в который ещё ничего не написали. */
function isEmptyTmp(
  id: string,
  messages: Record<string, unknown[] | undefined>,
): boolean {
  return isTmpSession(id) && (messages[id]?.length ?? 0) === 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
      const server = (await api.listSessions()).filter(
        (x) => !wasSessionDeleted(x.id),
      );
      // Оптимистичные tmp_-чаты есть только в этой вкладке — список с сервера
      // не должен их стирать (иначе открытый «Новый чат» пропадал).
      set((s) => {
        const local = s.sessions.filter(
          (x) => isTmpSession(x.id) && !server.some((y) => y.id === x.id),
        );
        return {
          sessions: [...local, ...server].sort(byUpdated),
          sessionError: false,
          error: null,
        };
      });
      // Подчищаем закрепления/папки чатов, которых на сервере больше нет
      // (удалены с другого устройства или до этой правки).
      const alive = new Set(server.map((x) => x.id));
      const st = get();
      const stale = [
        ...(st.pinnedSessions ?? []),
        ...Object.keys(st.chatFolderAssignments ?? {}),
      ].filter((id) => !isTmpSession(id) && !alive.has(id));
      if (stale.length > 0 && st.prefsSynced) st.forgetSessionPrefs?.(stale);
    } catch {
      set({ sessionError: true });
    }
  },

  select: async (id) => {
    // UX-fix: если sid уже в blacklist (сервер подтвердил отсутствие сессии) —
    // не идём в сеть повторно. Просто чистим URL и переключаемся на первую живую.
    if (id && isSessionDead(id)) {
      log.warn(
        t("sessions_slice.select_sid_uzhe_pomechen_dead_propuskaem"),
        id,
      );
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

    // Уходим из пустого «Нового чата» — он больше не нужен в списке.
    set((s) => {
      const prev = s.currentID;
      if (!prev || prev === id || !isEmptyTmp(prev, s.messages))
        return { currentID: id };
      const messages = { ...s.messages };
      delete messages[prev];
      return {
        currentID: id,
        sessions: s.sessions.filter((x) => x.id !== prev),
        messages,
      };
    });
    if (!id) return;
    // Временный чат («Новый чат» до первого сообщения) ещё не существует на
    // сервере. Запрос его истории отвечал 404, и обработчик «мёртвой сессии»
    // удалял только что созданный чат при клике по нему в боковой панели.
    if (isTmpSession(id)) {
      __pendingSelect.delete(id);
      return;
    }
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
    // Уже в пустом «Новом чате» — второй такой же не нужен. Раньше каждый
    // клик добавлял в боковую панель ещё один пустой «New chat».
    const { currentID, messages } = get();
    if (currentID && isEmptyTmp(currentID, messages)) return;
    const tempId = `tmp_${Date.now()}`;
    const tempSession: SessionInfo = {
      id: tempId,
      title: "New chat",
      time: { created: Date.now(), updated: Date.now() },
    };

    set((s) => ({
      // Прочие брошенные пустые tmp_-чаты убираем: в списке их не больше одного.
      sessions: [
        tempSession,
        ...s.sessions.filter((x) => !isEmptyTmp(x.id, s.messages)),
      ].sort(byUpdated),
      currentID: tempId,
      messages: { ...s.messages, [tempId]: [] },
      status: { ...s.status, [tempId]: "idle" as SessionStatus },
    }));
  },

  // Ответвление чата от сообщения.
  //
  // Сервер делает новый чат с копией истории до этого сообщения. Если
  // маршрута нет (старый бэкенд) или сессия ещё не материализована —
  // открываем обычный новый чат и честно сообщаем об этом вызывающей стороне,
  // а не делаем вид, что контекст переехал.
  forkSession: async (messageId) => {
    const sid = get().currentID;
    const fallback = async (): Promise<ForkOutcome> => {
      await get().newSession();
      return { ok: false, copied: 0, sessionId: get().currentID };
    };
    if (!sid || isTmpSession(sid)) return fallback();
    try {
      const { session, copied } = await api.forkSession(sid, messageId);
      set((s) => ({
        sessions: [
          session,
          ...s.sessions.filter((x) => x.id !== session.id),
        ].sort(byUpdated),
      }));
      await get().select(session.id);
      return { ok: true, copied, sessionId: session.id };
    } catch (e) {
      log.warn("[fork] серверный форк недоступен:", (e as Error).message);
      return fallback();
    }
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
      const draftTitle = get().sessionTitleOverrides?.[tempId];
      const session = await api.createSession(draftTitle || undefined);
      set((s) => {
        const overrides = { ...s.sessionTitleOverrides };
        if (overrides[tempId]) {
          overrides[session.id] = overrides[tempId];
          delete overrides[tempId];
        }
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
          // Пока шло создание, пользователь мог перейти в другой чат —
          // не выдёргиваем его обратно.
          currentID: s.currentID === tempId ? session.id : s.currentID,
          messages: msgs,
          status: st,
          sessionTitleOverrides: overrides,
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
      if (sessionCreationSettled === creation)
        sessionCreationSettled = Promise.resolve();
    }
  },

  // Полное удаление: сервер стирает историю, файлы, память проекта, процессы
  // и браузер чата. В UI чат исчезает сразу; при ошибке возвращается.
  removeSession: async (id) => {
    if (!id) return;
    const dropLocal = () =>
      set((s) => {
        const messages = { ...s.messages };
        delete messages[id];
        const status = { ...s.status };
        delete status[id];
        const workspaceRevision = { ...s.workspaceRevision };
        delete workspaceRevision[id];
        return {
          sessions: s.sessions.filter((x) => x.id !== id),
          messages,
          status,
          workspaceRevision,
          currentID: s.currentID === id ? null : s.currentID,
        };
      });

    // Оптимистичный чат на сервере не существует: удалять там нечего.
    // Раньше DELETE на tmp_ падал и «откат» возвращал чат обратно.
    if (isTmpSession(id)) {
      dropLocal();
      get().forgetSessionPrefs?.([id]);
      return;
    }

    // Cancel any in-flight requests and mark the session as dead so that
    // stale SSE / polling / select() calls are suppressed immediately.
    abortSessionRequests(id);
    markSessionDead(id);
    markSessionDeleted(id);

    const removedSession = get().sessions.find((x) => x.id === id);
    const removedMessages = get().messages[id];
    const wasCurrent = get().currentID === id;
    dropLocal();

    try {
      // 409 — ход агента ещё останавливается; сервер просит повторить.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.deleteSession(id);
          break;
        } catch (e) {
          if (e instanceof SessionGoneError) break; // уже удалён — цель достигнута
          if (attempt < 3 && /^409\b/.test((e as Error).message)) {
            await sleep(1500);
            continue;
          }
          throw e;
        }
      }
      get().forgetSessionPrefs?.([id]);
    } catch (e) {
      unmarkSessionDeleted(id);
      unmarkSessionDead(id);
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
