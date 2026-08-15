import { sessionSignal } from "../../api/abortRegistry";
import { api, SessionGoneError } from "../../api/client";
import { eventSessionId } from "../../api/eventGuards";
import type { ProcessedFile } from "../../api/files";
import { mergeMessages as mergeMessagesDeterministic } from "../../api/messageMerge";
import {
  PROMPT_RETRY_PAUSE_MS,
  promptRetryDecision,
} from "../../api/promptRetry";
import { assistantFinishState } from "../../api/turnFinality";
import { parseTurnState } from "../../api/turnVerdict";
import type { Message, Part, SessionStatus } from "../../api/types";
import { getSystemInstruction } from "../../config/systemInstruction";
import { messageText } from "../../lib/chatText";
import { isTmpSession, newActionId } from "../../lib/ids";
import { log } from "../../lib/log";
import { toast } from "../../lib/toast";
import { normalizeMessages, patchPartDelta } from "../helpers";
import { sessionFsm } from "../sessionFsm";
import { awaitTurnCompletion } from "../turnCompletion";
import { turnSettle } from "../turnSettle";
import type { MessagesSlice, Slice } from "../types";
import { EVENT_HANDLERS } from "./eventHandlers";

// P1.6 FSM: per-session состояние busy/idle и idle-резолверы вынесены в
// ../sessionFsm.ts (бывшие __locallyBusy / __idleResolvers). Поведение 1:1.
// Safety watchdog only; normal completion comes from SSE session.idle,
// the final prompt response, or HTTP reconciliation. Keep it longer than
// ordinary long multi-tool runs to avoid false completion.
const SEND_HARD_TIMEOUT_MS = 15 * 60 * 1000; // 15 min safety limit

// ---------------------------------------------------------------------------
// Релиз 4: send() разбит на чистые функции — их можно тестировать без стора и сети,
// а сам send() остаётся оркестратором: сессия, статусы, ожидание финала.
// ---------------------------------------------------------------------------

// Workspace и системный prompt принадлежат native runtime. Browser хранит только
// представление чата и никогда не является источником системной политики.

/** Attachment-части для оптимистичного user-сообщения (чистая функция). */
export function buildAttachmentParts(attachments: ProcessedFile[]): Part[] {
  return attachments.map((a) => ({
    type: "attachment" as const,
    name: a.name,
    size: a.size,
    kind: a.kind,
    path: a.workspacePath || a.uploadedPath || undefined,
    dataUrl: a.dataUrl || undefined,
  }));
}

/** Оптимистичное user-сообщение (генерация локального id — единственный side effect). */
function buildUserMessage(text: string, attachments: ProcessedFile[]): Message {
  return {
    id: newLocalMessageId(),
    role: "user",
    parts: [...buildAttachmentParts(attachments), { type: "text", text }],
  };
}

/**
 * Native prompt parts. Вложение — отдельная typed-сущность, а не служебный
 * текст внутри user-message. Browser передаёт только metadata/path; содержимое
 * image/PDF runtime читает из собственного workspace непосредственно перед
 * вызовом модели. Поэтому размер JSON-prompt не растёт на base64 и никакой
 * attachment manifest не может попасть в видимый текст пользователя.
 */
export function buildPromptParts(
  attachments: ProcessedFile[],
  text: string,
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const att of attachments) {
    if (!att.workspacePath) continue; // ещё не загруженное вложение агенту не видно
    const notes: string[] = [];
    if (att.kind === "zip") {
      notes.push(
        typeof att.entryCount === "number"
          ? `zip-архив, ${att.entryCount} файлов, ещё не распакован`
          : "zip-архив, ещё не распакован",
      );
    }
    parts.push({
      type: "attachment",
      name: att.serverName || att.name,
      path: att.workspacePath,
      size: att.size,
      mime: att.mime,
      kind: att.kind,
      ...(notes.length ? { note: notes.join(", ") } : {}),
    });
  }
  // Текст — отдельная часть и никогда не содержит runtime metadata.
  parts.push({ type: "text", text });
  return parts;
}

/**
 * Детекция финала ответа для HTTP-поллера.
 *
 * Реализация переехала в `src/api/turnFinality.ts` — туда же, где живёт
 * различие «шаг против финала». Ре-экспорт оставлен намеренно: две копии
 * правила «ход закончился» разошлись бы молча, а импорт из прежнего места
 * продолжает работать.
 */
export { assistantFinishState };

let __activeStoreFlush: (() => void) | null = null;
/**
 * Досылает накопленные стрим-дельты одним обновлением стора.
 * Экспортируется для тестов (там нет ожидания 16мс-таймера).
 */
export function flushStreamDeltas() {
  __activeStoreFlush?.();
}

// Дедупликация ответов на разрешения — в `../permissionDedup` (permissionDedup),
// окно стабилизации финального маркера — в `../turnSettle` (turnSettle). Оба
// были модульными переменными прямо здесь; см. шапки тех файлов о том, почему
// состояние уехало из этого модуля.

/**
 * События, которые считаются активностью хода.
 *
 * Список положительный, а не «всё кроме»: неизвестное событие не должно
 * продлевать окно бесконечно. Совпадает с классификацией `classifyEvent`
 * в `server/turn-orchestrator.mjs`.
 */
const ACTIVITY_EVENT_TYPES = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.removed",
  "permission.asked",
  "permission.responded",
  "question.asked",
  "question.replied",
  "question.rejected",
  "session.status",
]);

/**
 * Collision-free id for optimistic local messages. `Date.now()` collides on
 * a fast double send (same millisecond); `crypto.randomUUID()` cannot. The
 * fallback covers non-secure contexts (plain HTTP), where randomUUID is
 * unavailable. The `local_` prefix is load-bearing: all optimistic-message
 * correlation checks `isLocalMessage(id)`.
 */
function newLocalMessageId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local_${uuid}`;
}

export const createMessagesSlice: Slice<MessagesSlice> = (set, get) => {
  __activeStoreFlush = () => get().flushStreamDeltas();
  return {
    messages: {},
    attachments: [],
    workspaceRevision: {},
    // Проекция хода с сервера, по сессии. Клиент её только читает — состояние
    // хода принадлежит серверу (I-10). Пишется поллером вердикта внутри send();
    // после перезагрузки страницы поллер не запущен, поэтому значения здесь нет,
    // и `indicatorFor(null)` отвечает «не знаю», а не «скрыть».
    turnProjection: {},
    failedSendText: null,
    _deltaBuffer: new Map(),
    _flushTimer: null,

    flushStreamDeltas: () => {
      const timer = get()._flushTimer;
      if (timer) {
        clearTimeout(timer);
        set({ _flushTimer: null });
      }
      const buf = get()._deltaBuffer;
      if (!buf || buf.size === 0) return;
      const pending = [...buf.values()];
      buf.clear();
      set((s) => {
        let messages = s.messages;
        for (const d of pending) {
          messages = {
            ...messages,
            [d.sid]: patchPartDelta(
              messages[d.sid] ?? [],
              d.messageID,
              d.partID,
              d.field,
              d.text,
            ),
          };
        }
        return { messages };
      });
    },

    addAttachments: (files) =>
      set((s) => ({ attachments: [...s.attachments, ...files] })),

    removeAttachment: (name) =>
      set((s) => ({
        attachments: s.attachments.filter((a) => a.name !== name),
      })),

    clearAttachments: () => set({ attachments: [] }),

    /**
     * Перечитать вердикт хода по требованию пользователя (действие при `stuck`).
     *
     * Только чтение: ничего не отправляется заново. Согласованное решение —
     * повторная отправка при `stuck` могла бы дать второй ответ, если первый
     * всё-таки идёт, то есть ровно тот фантомный дубль, ради которого заведён
     * реестр действий. В большинстве случаев ответ уже есть на сервере и просто
     * не дошёл до вкладки, и одного перечитывания достаточно.
     */
    refreshTurnProjection: async (sessionId) => {
      try {
        const parsed = parseTurnState(await api.turnState(sessionId));
        if (!parsed) return;
        set((s) => ({
          turnProjection: { ...s.turnProjection, [sessionId]: parsed.turn },
        }));
      } catch {
        // Сетевой сбой — проекция остаётся прежней. Обнулять её значило бы
        // спрятать `stuck` и снова выдать неизвестность за отсутствие проблемы.
      }
    },

    clearFailedSendText: () => set({ failedSendText: null }),
    // Подставляет текст в Composer через существующий механизм failedSendText:
    // Composer забирает его в поле ввода и сразу очищает.
    prefillComposer: (text) => set({ failedSendText: text }),

    editAndResend: async (messageId, text) => {
      const trimmed = text.trim();
      const sid = get().currentID;
      if (!trimmed || !sid || isTmpSession(sid)) return;
      const list = get().messages[sid] ?? [];
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      // Просим движок откатить сессию ДО этого сообщения. Делаем это раньше
      // локального обрезания: если роут не поддерживается, историю никто не
      // рвёт и пользователь видит честную картину вместо «пропавших» сообщений,
      // которые всё равно вернёт следующий HTTP-снапшот.
      let reverted = false;
      // Локальные (ещё не подтверждённые сервером) сообщения откатывать нечем.
      if (!messageId.startsWith("local_")) {
        try {
          await api.revertMessage(sid, messageId);
          reverted = true;
        } catch (e) {
          log.warn("[editAndResend] revert unsupported or failed:", e);
        }
      }
      if (reverted) {
        set((s) => ({
          messages: {
            ...s.messages,
            [sid]: (s.messages[sid] ?? []).slice(0, idx),
          },
        }));
      } else {
        // Не пишем в state.error: это не сбой отправки (её плашка висела бы,
        // пока не случится следующая ошибка), а разовое предупреждение.
        toast(
          "info",
          "Откат истории недоступен: прежняя версия запроса осталась в контексте модели.",
        );
      }
      await get().send(trimmed);
    },

    regenerate: async (assistantMessageId) => {
      const sid = get().currentID;
      if (!sid || isTmpSession(sid)) return;
      const list = get().messages[sid] ?? [];
      const idx = list.findIndex((m) => m.id === assistantMessageId);
      if (idx === -1) return;
      // Перегенерация = повтор ближайшего предшествующего запроса пользователя,
      // поэтому откатываем историю именно по него, а не по ответ ассистента.
      for (let i = idx; i >= 0; i--) {
        const m = list[i];
        if (m?.role !== "user") continue;
        const text = messageText(m).trim();
        if (!text) continue;
        await get().editAndResend(m.id, text);
        return;
      }
    },

    send: async (text) => {
      // Ключ идемпотентности создаётся здесь — в момент создания действия, а
      // не при отправке (OWNERSHIP_AND_DURABILITY §4). Разница существенна:
      // материализация сессии ниже может занять секунды, и ключ, выданный
      // после неё, отличался бы у повторной попытки, а сервер увидел бы два
      // разных действия и создал второй ход.
      const actionId = newActionId();
      const { currentID, newSession, materializeSession, selectedModel } =
        get();
      let sid = currentID;
      // Оптимистичный tmp_-чат существует только на клиенте: сессию на сервере
      // (а с ней и контейнер) создаём здесь, при первой отправке. Именно этот
      // момент пользователь и так ждёт — дальше идёт ответ модели.
      if (!sid || isTmpSession(sid)) {
        if (!sid) await newSession();
        await materializeSession();
        sid = get().currentID;
        // Материализация не удалась (сеть, 5xx) — сообщение не отправляем,
        // ошибка уже положена в стор и показана пользователю.
        if (!sid || isTmpSession(sid)) return;
      }
      const sidStr = sid as string;

      const currentAttachments = get().attachments;
      // Релиз 4: сборка оптимистичного сообщения вынесена в чистые функции.
      const userMsg = buildUserMessage(text, currentAttachments);
      const requestGen = sessionFsm.beginRequest(sidStr);
      set((s) => ({
        status: { ...s.status, [sidStr]: "busy" },
        messages: {
          ...s.messages,
          [sidStr]: [...(s.messages[sidStr] ?? []), userMsg],
        },
      }));

      // P0.3 — deterministic source-aware merge (replaces JSON-length heuristic)
      const mergeMessages = (
        msgs: Message[],
        existing: Message[],
      ): Message[] => {
        return mergeMessagesDeterministic(msgs, existing);
      };

      const doFinalFetch = async () => {
        try {
          const msgs = normalizeMessages(await api.listMessages(sidStr));
          set((s) => {
            const existing = s.messages[sidStr] ?? [];
            const merged = mergeMessages(msgs, existing);
            return { messages: { ...s.messages, [sidStr]: merged } };
          });
        } catch {
          // non-fatal
        }
      };

      try {
        // Релиз 4: сборка prompt-частей вынесена в чистую функцию buildPromptParts —
        // send() остаётся оркестратором (сессия, статусы, ожидание финала).
        const parts = buildPromptParts(get().attachments, text);

        // Fire-and-forget prompt: сервер сам стримит события через SSE.
        // Не полагаемся на возврат promptWithParts как индикатор финиша —
        // ждём ЛИБО session.idle из SSE, ЛИБО подтверждённый через HTTP-polling
        // финал (два опроса подряд показывают одинаковое finish + отсутствие новых сообщений).
        // Это защищает от нестабильного SSE (мобильная сеть, VPN).
        // Retryable prompt: временные 503 или сетевые ошибки не должны
        // сбрасывать индикатор работы ассистента. Повторяем до 2 раз.
        //
        // ВАЖНО (фикс «фантомных» сообщений): POST /message висит открытым
        // ВЕСЬ ход агента — на длинной задаче это минуты, и такое соединение
        // убивают edge-прокси (Railway) или мобильная сеть. Слепой повтор в
        // этот момент отправлял ДУБЛИКАТ промпта: в чате сам собой появлялся
        // второй user-message, старый transport-контур прерывал текущий ход и начинал
        // обрабатывать дубль («агент остановился → пришло сообщение →
        // продолжил»). Поэтому повторяем ТОЛЬКО раннюю ошибку доставки:
        // если запрос прожил дольше PROMPT_DELIVERED_MS и умер — промпт уже
        // на сервере, ход идёт; возвращаем null и ждём финал через SSE
        // session.idle / HTTP-поллер (send() на них и рассчитан).
        //
        // Native action ledger включён всегда: повтор с тем же actionId
        // идемпотентен. Порог ниже лишь избегает лишнего длинного HTTP-retry
        // после того, как turn уже гарантированно стартовал.
        // Само решение «повторять / считать доставленным / сдаться» и порог
        // живут в `src/api/promptRetry.ts` и проверяются там же тестом. Здесь
        // остался только цикл, исполняющий вердикт.
        async function retryablePrompt(
          sidStr: string,
          parts: Record<string, unknown>[],
          model?: import("../../api/client").PromptModel,
          systemInstruction?: string,
          signal?: AbortSignal,
          retries = 2,
        ) {
          let lastErr: Error | null = null;
          for (let i = 0; i <= retries; i++) {
            const attemptStarted = Date.now();
            try {
              return await api.promptWithParts(
                sidStr,
                parts,
                model,
                systemInstruction,
                signal,
                // Тот же ключ на каждой попытке — в этом весь смысл.
                actionId,
              );
            } catch (err) {
              lastErr = err as Error;
              const verdict = promptRetryDecision({
                message: (err as Error).message || "",
                elapsedMs: Date.now() - attemptStarted,
                attempt: i,
                retries,
              });
              if (verdict === "assume-delivered") {
                log.warn(
                  "[send] prompt-соединение оборвалось после доставки — " +
                    "повтор не отправляем (иначе дубликат сообщения); " +
                    "финал подтвердят SSE/поллер",
                );
                return null;
              }
              if (verdict === "fail") throw err;
              await new Promise((r) => setTimeout(r, PROMPT_RETRY_PAUSE_MS));
            }
          }
          throw lastErr;
        }

        // Системный промпт загружается с сервера один раз и кэшируется.
        const systemInstruction = await getSystemInstruction();
        const promptPromise = retryablePrompt(
          sidStr,
          parts,
          selectedModel ?? undefined,
          systemInstruction || undefined,
          sessionSignal(sidStr),
          2,
        );

        // P2-fix: вложения уже ушли в prompt — очищаем композер сразу,
        // не дожидаясь конца генерации. При ошибке send() вернём их обратно.
        set({ attachments: [] });

        await awaitTurnCompletion({
          sessionId: sidStr,
          requestGen,
          promptPromise,
          hardTimeoutMs: SEND_HARD_TIMEOUT_MS,
          onTurnProjection: (turn) =>
            set((s) => ({
              turnProjection: { ...s.turnProjection, [sidStr]: turn },
            })),
          onFailed: () =>
            set((s) => ({
              status: { ...s.status, [sidStr]: "error" as SessionStatus },
            })),
          onSnapshot: (msgs) =>
            set((s) => {
              const existing = s.messages[sidStr] ?? [];
              const merged = mergeMessages(normalizeMessages(msgs), existing);
              return { messages: { ...s.messages, [sidStr]: merged } };
            }),
        });
      } catch (e) {
        sessionFsm.markIdle(sidStr, requestGen);
        if (e instanceof SessionGoneError) {
          log.warn("[send] session gone on backend, recreating:", e.sessionId);
          // Успел ли агент начать отвечать в мёртвой сессии. Если да, то
          // 410 прилетел не от «пустой» сессии, а от сбоя посреди хода —
          // и авто-пересылка текста в новую сессию выглядела бы как
          // сообщение, отправленное само собой. Проверяем ДО очистки стора.
          const hadAssistantReply = (get().messages[sidStr] ?? []).some(
            (m) => m.role === "assistant" && messageText(m).trim().length > 0,
          );
          set((s) => {
            const messages = { ...s.messages };
            delete messages[sidStr];
            return {
              sessions: s.sessions.filter((x) => x.id !== sidStr),
              messages,
              currentID: s.currentID === sidStr ? null : s.currentID,
              status: { ...s.status, [sidStr]: "idle" as SessionStatus },
            };
          });
          try {
            await get().newSession();
            const newSid = get().currentID;
            if (newSid && !isTmpSession(newSid)) {
              // Race-fix: пока первая попытка висела, пользователь мог уже
              // прикрепить НОВЫЕ файлы к следующему сообщению. Не затираем
              // их старым снимком и не отдаём авторетраю (иначе новые
              // файлы ушли бы под старым текстом) — возвращаем текст в
              // Composer через failedSendText для ручной отправки.
              // Тот же путь, если ответ уже начинался: решение о повторе
              // принимает пользователь, а не UI.
              if (get().attachments.length > 0 || hadAssistantReply) {
                set({ failedSendText: text });
                if (hadAssistantReply) {
                  toast(
                    "info",
                    "Сессия оборвалась во время ответа. Запрос возвращён в поле ввода — отправьте повторно, если нужно.",
                  );
                }
                return;
              }
              // P2-fix: вложения были очищены при первой попытке — вернём,
              // чтобы повторная отправка ушла с ними (функциональный set —
              // не перезаписываем вложения, появившиеся между проверкой и
              // записью).
              if (currentAttachments.length > 0)
                set((s) => ({
                  attachments:
                    s.attachments.length === 0
                      ? currentAttachments
                      : s.attachments,
                }));
              get()
                .send(text)
                .catch(() => {});
            }
          } catch (recErr) {
            set((_s) => ({ error: (recErr as Error).message }));
          }
          return;
        }
        set((s) => ({
          error: (e as Error).message,
          // P2-fix: не терять набранный текст — Composer вернёт его в поле ввода.
          failedSendText: text,
          status: { ...s.status, [sidStr]: "error" },
          messages: {
            ...s.messages,
            [sidStr]: (s.messages[sidStr] ?? []).filter(
              (m) => m.id !== userMsg.id,
            ),
          },
          // P2-fix: вложения были очищены при отправке — возвращаем.
          attachments:
            s.attachments.length === 0 ? currentAttachments : s.attachments,
        }));
        return;
      }

      await doFinalFetch();
      sessionFsm.markIdle(sidStr, requestGen);
      set((s) => {
        // Релиз 4: если за время ожидания стартовал более новый send(),
        // не сбиваем его busy-статус устаревшим idle.
        if (!sessionFsm.isCurrent(sidStr, requestGen)) return {};
        const currentStatus = s.status[sidStr];
        const finalStatus: SessionStatus =
          currentStatus === "error" ? "error" : "idle";
        return {
          status: { ...s.status, [sidStr]: finalStatus },
        };
      });
    },

    applyEvent: (e) => {
      // Релиз 3: любое не-дельтовое событие сначала досылает буфер дельт,
      // чтобы не нарушать порядок применения (например, message.part.updated
      // затирает поле целиком и должен видеть уже применённые дельты).
      if (e.type !== "message.part.delta") get().flushStreamDeltas();
      const p = e.properties;
      // Нормализация сетевого payload сосредоточена в `eventGuards`, чтобы
      // неизвестное/повреждённое событие не роняло React-поток.
      const sid = eventSessionId(p);

      // Активность отменяет отложенное закрытие хода. Стоит ДО обработчика и до
      // всякой обработки: маркер завершённости приходит на каждом шаге агента,
      // и подтверждает его только тишина. Событие, которое само окажется
      // маркером, взведёт окно заново ниже — порядок именно такой.
      if (sid && ACTIVITY_EVENT_TYPES.has(e.type)) turnSettle.cancel(sid);

      const handler = EVENT_HANDLERS[e.type];
      // Неизвестный тип события игнорируется молча — движок добавляет их
      // между версиями, и новый тип не должен ломать поток.
      if (handler) handler({ set, get }, sid, p);
    },
  };
};
