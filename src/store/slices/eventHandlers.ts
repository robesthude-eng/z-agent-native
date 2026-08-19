import { api } from "../../api/client";
import { eventMessageId, eventPartId, statusText } from "../../api/eventGuards";
import { mergeMessages as mergeMessagesDeterministic } from "../../api/messageMerge";
import { finalMarkerOf } from "../../api/turnFinality";
import type {
  Message,
  Part,
  SessionInfo,
  SessionStatus,
} from "../../api/types";
import { isTmpSession } from "../../lib/ids";
import {
  normalizeMessage,
  normalizeMessages,
  patchPart,
  patchPartDelta,
  upsertMessage,
} from "../helpers";
import { permissionDedup } from "../permissionDedup";
import { sessionFsm } from "../sessionFsm";
import { turnSettle } from "../turnSettle";
import type { MessagesSlice, Slice, State } from "../types";
import { byUpdated } from "../types";

/**
 * Обработчики SSE-событий — по одному на тип.
 *
 * `applyEvent` был switch'ом на двести семьдесят строк внутри слайса: чтобы
 * прочитать обработку одного события, приходилось пролистывать одиннадцать
 * чужих. Разложено таблицей, а не цепочкой `if`: список обработчиков видно целиком,
 * а добавление нового native runtime-события не требует перечитывать остальные.
 *
 * Общее для всех событий — досылка буфера дельт, извлечение id сессии и
 * снятие отложенного закрытия хода — осталось в `applyEvent`: это не свойство
 * конкретного события, а порядок, в котором обязаны идти шаги.
 */

/** Точные типы `set`/`get` слайса — берём из его же сигнатуры, не угадывая. */
type SetState = Parameters<Slice<MessagesSlice>>[0];
type GetState = Parameters<Slice<MessagesSlice>>[1];

export interface EventCtx {
  set: SetState;
  get: GetState;
}

/** Свойства события. Форма динамическая — поля достаём через eventGuards. */
type EventProps = Record<string, unknown> & {
  session?: SessionInfo;
  status?: unknown;
  message?: Message;
  info?: Record<string, unknown>;
  part?: Part;
  field?: string;
  delta?: unknown;
  id?: string;
  tool?: unknown;
  input?: unknown;
};

/**
 * @param sid id сессии события; уже извлечён и может быть пустым — каждый
 *   обработчик проверяет его сам, потому что не всем он обязателен.
 */
export type EventHandler = (ctx: EventCtx, sid: string, p: EventProps) => void;

// Релиз 3: буферизация стрим-дельт. Сотни SSE-дельт в секунду превращаются
// в максимум ~60 обновлений стора в секунду (раз в DELTA_FLUSH_MS) — иначе
// каждый токен заставляет React пересчитывать всё дерево сообщений.
export const DELTA_FLUSH_MS = 16;

/** Появление или изменение сессии в списке. */
const upsertSession: EventHandler = ({ set }, _sid, p) => {
  if (!p.session) return;
  set((s: State) => ({
    sessions: [
      p.session as SessionInfo,
      ...s.sessions.filter((x) => x.id !== p.session?.id),
    ].sort(byUpdated),
  }));
};

/** Сессия удалена на сервере — убираем её и её ленту. */
const removeSession: EventHandler = ({ set }, sid) => {
  if (!sid) return;
  set((s: State) => {
    const messages = { ...s.messages };
    const workspaceRevision = { ...s.workspaceRevision };
    delete messages[sid];
    delete workspaceRevision[sid];
    return {
      sessions: s.sessions.filter((x) => x.id !== sid),
      messages,
      workspaceRevision,
      currentID: s.currentID === sid ? null : s.currentID,
    };
  });
};

/**
 * Закрыть ход по явному сигналу движка.
 *
 * Общее тело для `session.status: idle` и `session.idle`: это факт, а не
 * подсказка. Отложенное закрытие снимается, чтобы оно не сработало вторым
 * разом уже поверх нового хода.
 */
function closeTurnNow(ctx: EventCtx, sid: string): void {
  turnSettle.cancel(sid);
  if (sessionFsm.isBusy(sid)) sessionFsm.resolveIdle(sid);
  ctx.set((s: State) => ({
    status: { ...s.status, [sid]: "idle" as SessionStatus },
  }));
}

const applySessionStatus: EventHandler = (ctx, sid, p) => {
  if (!sid || !p.status) return;
  const st = statusText(p.status);
  if (st === "idle") {
    closeTurnNow(ctx, sid);
    return;
  }
  ctx.set((s: State) => ({
    status: { ...s.status, [sid]: st as SessionStatus },
  }));
};

const applySessionIdle: EventHandler = (ctx, sid) => {
  if (!sid) return;
  closeTurnNow(ctx, sid);
};

const removeMessage: EventHandler = ({ set }, sid, p) => {
  const messageID = eventMessageId(p, "message");
  if (!sid || !messageID) return;
  set((s: State) => ({
    messages: {
      ...s.messages,
      [sid]: (s.messages[sid] ?? []).filter((m) => m.id !== messageID),
    },
  }));
};

const updateMessage: EventHandler = ({ set }, sid, p) => {
  if (!sid) return;
  const msg = p.message as Message | undefined;
  const info = p.info as Record<string, unknown> | undefined;

  if (msg) {
    set((s: State) => ({
      messages: {
        ...s.messages,
        [sid]: upsertMessage(s.messages[sid] ?? [], normalizeMessage(msg)),
      },
    }));
    const marker = finalMarkerOf(normalizeMessage(msg));
    const finish = msg?.info?.finish || (msg as { finish?: string })?.finish;
    // `step` — модель остановилась ради инструмента либо инструмент ещё
    // работает. Ход продолжается, и трогать статус нельзя: именно здесь
    // `busy` снимался посреди работы агента, очередь считала сессию свободной
    // и отправляла в неё следующее сообщение — движок прерывал текущий ответ
    // и начинал заново.
    if (marker === "final") {
      // Даже похожий на финал маркер остаётся подсказкой. Закрываем ход не
      // сейчас, а если дальше в сессии станет тихо: любое следующее событие
      // снимет таймер в начале applyEvent.
      const isError = finish === "error";
      turnSettle.arm(sid, () => {
        if (sessionFsm.isBusy(sid)) sessionFsm.resolveIdle(sid);
        set((s: State) => ({
          status: {
            ...s.status,
            [sid]: (isError ? "error" : "idle") as SessionStatus,
          },
        }));
      });
    }
    return;
  }

  if (info?.id) {
    const shell: Message = {
      id: info.id as string,
      role: (info.role as Message["role"]) || "assistant",
      parts: [],
      info: info as Message["info"],
    };
    set((s: State) => ({
      messages: {
        ...s.messages,
        [sid]: upsertMessage(s.messages[sid] ?? [], shell),
      },
    }));
  }
};

const WORKSPACE_MUTATING_TOOLS = new Set([
  "bash",
  "shell",
  "write",
  "edit",
  "applypatch",
  "apply_patch",
  "patch",
]);

function completedWorkspaceMutation(part: Part): boolean {
  if (part.type !== "tool") return false;
  const tool =
    typeof (part as { tool?: unknown }).tool === "string"
      ? String((part as { tool?: unknown }).tool).toLowerCase()
      : "";
  if (!WORKSPACE_MUTATING_TOOLS.has(tool)) return false;
  const state = (part as { state?: unknown }).state;
  const status =
    typeof state === "object" && state !== null && "status" in state
      ? String((state as { status?: unknown }).status ?? "")
      : typeof state === "string"
        ? state
        : "";
  return status === "completed" || status === "success" || status === "done";
}

function bumpWorkspaceRevision(s: State, sid: string) {
  return {
    ...s.workspaceRevision,
    [sid]: (s.workspaceRevision[sid] ?? 0) + 1,
  };
}

const workspaceChanged: EventHandler = ({ set }, sid) => {
  if (!sid) return;
  set((s: State) => ({ workspaceRevision: bumpWorkspaceRevision(s, sid) }));
};

const updatePart: EventHandler = ({ set }, sid, p) => {
  const messageID = eventMessageId(p);
  const part = p.part as Part | undefined;
  if (!sid || !messageID || !part) return;
  set((s: State) => {
    const updated = patchPart(s.messages[sid] ?? [], messageID, part);
    return {
      messages: { ...s.messages, [sid]: updated },
      ...(completedWorkspaceMutation(part)
        ? { workspaceRevision: bumpWorkspaceRevision(s, sid) }
        : {}),
    };
  });
};

const applyPartDelta: EventHandler = ({ set, get }, sid, p) => {
  const messageID = eventMessageId(p);
  const partID = eventPartId(p);
  const field = p.field as string | undefined;
  const delta = p.delta;
  if (!sid || !messageID || !partID || !field || delta === undefined) return;

  if (typeof delta === "string") {
    // Разделитель — NUL-escape, а не буквальный байт: он не встречается в
    // идентификаторах, поэтому склейка четырёх полей не может дать один
    // и тот же ключ для разных частей.
    const key = `${sid}\u0000${messageID}\u0000${partID}\u0000${field}`;
    const buf = get()._deltaBuffer;
    const buffered = buf.get(key);
    if (buffered) {
      buffered.text += delta;
    } else {
      buf.set(key, { sid, messageID, partID, field, text: delta });
    }
    if (!get()._flushTimer) {
      const timer = setTimeout(() => {
        get().flushStreamDeltas();
      }, DELTA_FLUSH_MS);
      set({ _flushTimer: timer });
    }
    return;
  }

  // Не-строковая дельта — досылаем буфер и применяем сразу (порядок!).
  get().flushStreamDeltas();
  set((s: State) => {
    const updated = patchPartDelta(
      s.messages[sid] ?? [],
      messageID,
      partID,
      field,
      delta,
    );
    return { messages: { ...s.messages, [sid]: updated } };
  });
};

const streamCorrupted: EventHandler = ({ set }) => {
  // P0-fix: битый чанк из стрима — показываем плашку вместо непредсказуемого
  // поведения/белого экрана. Пропущенное содержимое дотянет httpPoller /
  // doFinalFetch.
  set({
    error:
      "Стрим прерван: получен повреждённый фрагмент данных. " +
      "Ответ мог отобразиться не полностью.",
  });
};

const streamReconnected: EventHandler = ({ set, get }) => {
  // P1-fix: SSE переподключился после разрыва — события за время разрыва
  // потеряны (нет Last-Event-ID replay). Один раз дотягиваем историю активной
  // сессии и мержим детерминированно.
  const cur = get().currentID;
  if (!cur || isTmpSession(cur)) return;
  void (async () => {
    try {
      const msgs = normalizeMessages(await api.listMessages(cur));
      if (msgs.length === 0) return;
      set((s: State) => ({
        messages: {
          ...s.messages,
          [cur]: mergeMessagesDeterministic(msgs, s.messages[cur] ?? []),
        },
      }));
    } catch {
      /* non-fatal — следующий reconnect или поллер дотянет */
    }
  })();
};

const permissionAsked: EventHandler = ({ set }, sid, p) => {
  if (!sid || !p.id) return;
  // Native runtime approves tools on the server. A leftover permission.asked
  // is compatibility noise: never surface a card and never fire a 404 reply.
  // Claim first so a replay after we already discarded the same id cannot
  // re-insert it into the queue.
  permissionDedup.claim(String(p.id));
  set((s: State) => ({
    permissions: s.permissions.filter((x) => x.id !== p.id),
  }));
};

const permissionResponded: EventHandler = ({ set }, _sid, p) => {
  if (!p.id) return;
  set((s: State) => ({
    permissions: s.permissions.filter((x) => x.id !== p.id),
  }));
};

/**
 * Таблица: тип события → обработчик.
 *
 * Событие, которого здесь нет, игнорируется молча — так же, как раньше делала
 * ветка `default`. Это намеренно: движок добавляет типы между версиями, и
 * неизвестное событие не должно ломать поток.
 */
export const EVENT_HANDLERS: Readonly<Record<string, EventHandler>> = {
  "session.created": upsertSession,
  "session.updated": upsertSession,
  "session.removed": removeSession,
  "session.status": applySessionStatus,
  "session.idle": applySessionIdle,
  "message.removed": removeMessage,
  "message.updated": updateMessage,
  "message.part.updated": updatePart,
  "message.part.delta": applyPartDelta,
  "stream.corrupted": streamCorrupted,
  "stream.reconnected": streamReconnected,
  "permission.asked": permissionAsked,
  "permission.responded": permissionResponded,
  "file.edited": workspaceChanged,
  "file.watcher.updated": workspaceChanged,
};
