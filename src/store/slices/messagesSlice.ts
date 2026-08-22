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
import { dispositionOf, parseTurnState } from "../../api/turnVerdict";
import type { Message, Part, SessionStatus } from "../../api/types";
import { getSystemInstruction } from "../../config/systemInstruction";
import { messageText } from "../../lib/chatText";
import { isTmpSession, newActionId } from "../../lib/ids";
import { log } from "../../lib/log";
import { clearStopMarker } from "../../lib/stopUx";
import { toast } from "../../lib/toast";
import { normalizeMessages, patchPartDelta } from "../helpers";
import { sessionFsm } from "../sessionFsm";
import { awaitTurnCompletion } from "../turnCompletion";
import { turnSettle } from "../turnSettle";
import type { MessagesSlice, Slice } from "../types";
import { EVENT_HANDLERS } from "./eventHandlers";

const SEND_HARD_TIMEOUT_MS = 15 * 60 * 1000;

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

function buildUserMessage(text: string, attachments: ProcessedFile[]): Message {
  return {
    id: newLocalMessageId(),
    role: "user",
    parts: [...buildAttachmentParts(attachments), { type: "text", text }],
  };
}

export function buildPromptParts(
  attachments: ProcessedFile[],
  text: string,
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const att of attachments) {
    if (!att.workspacePath) continue;
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
  parts.push({ type: "text", text });
  return parts;
}

export { assistantFinishState };

let __activeStoreFlush: (() => void) | null = null;
export function flushStreamDeltas() {
  __activeStoreFlush?.();
}

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

function newLocalMessageId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local_${uuid}`;
}

/**
 * Convert the server-owned turn projection into only the coarse session status
 * that legacy UI still consumes. The projection remains the source of truth;
 * status is merely a compatibility view for Composer/session badges.
 */
function recoveredSessionStatus(
  turn: import("../../api/turnVerdict").TurnProjection | null,
): SessionStatus {
  switch (dispositionOf(turn)) {
    case "busy":
    case "waiting":
      return "busy";
    case "failed":
      return "error";
    case "stuck":
      return "stale";
    default:
      return "idle";
  }
}

export const createMessagesSlice: Slice<MessagesSlice> = (set, get) => {
  __activeStoreFlush = () => get().flushStreamDeltas();
  return {
    messages: {},
    attachments: [],
    workspaceRevision: {},
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

    refreshTurnProjection: async (sessionId) => {
      try {
        const parsed = parseTurnState(await api.turnState(sessionId));
        if (!parsed?.orchestrator) return;
        const recovered = recoveredSessionStatus(parsed.turn);
        set((s) => ({
          turnProjection: { ...s.turnProjection, [sessionId]: parsed.turn },
          status: { ...s.status, [sessionId]: recovered },
        }));
      } catch {
        // Preserve the last known state. A reconnect/reload monitor will retry;
        // losing the projection here would turn a network blink into fake idle.
      }
    },

    clearFailedSendText: () => set({ failedSendText: null }),
    prefillComposer: (text) => set({ failedSendText: text }),

    editAndResend: async (messageId, text) => {
      const trimmed = text.trim();
      const sid = get().currentID;
      if (!trimmed || !sid || isTmpSession(sid)) return;
      const list = get().messages[sid] ?? [];
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx === -1) return;

      let reverted = false;
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
      for (let i = idx; i >= 0; i--) {
        const m = list[i];
        if (m?.role !== "user") continue;
        const text = messageText(m).trim();
        if (!text) continue;
        await get().editAndResend(m.id, text);
        return;
      }
    },

    send: async (text, attachmentsOverride, actionIdOverride) => {
      const actionId = actionIdOverride || newActionId();
      const { currentID, newSession, materializeSession, selectedModel } = get();
      let sid = currentID;
      if (!sid || isTmpSession(sid)) {
        if (!sid) await newSession();
        try {
          await materializeSession();
        } catch (e) {
          set((s) => ({
            error: (e as Error).message,
            failedSendText: text,
            attachments:
              s.attachments.length === 0
                ? (attachmentsOverride ?? s.attachments)
                : s.attachments,
          }));
          return;
        }
        sid = get().currentID;
        if (!sid || isTmpSession(sid)) return;
      }
      const sidStr = sid as string;
      // Новый ход стирает маркер «Стоп» прошлого: иначе ярлык
      // «Остановлено пользователем» прилипал к следующему ответу, который
      // агент завершил сам.
      clearStopMarker(sidStr);

      const currentAttachments = attachmentsOverride ?? get().attachments;
      const userMsg = buildUserMessage(text, currentAttachments);
      const requestGen = sessionFsm.beginRequest(sidStr);
      set((s) => ({
        status: { ...s.status, [sidStr]: "busy" },
        messages: {
          ...s.messages,
          [sidStr]: [...(s.messages[sidStr] ?? []), userMsg],
        },
      }));

      const mergeMessages = (
        msgs: Message[],
        existing: Message[],
      ): Message[] => mergeMessagesDeterministic(msgs, existing);

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
        const parts = buildPromptParts(currentAttachments, text);

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
                  "[send] prompt-соединение оборвалось после доставки — повтор не отправляем; финал подтвердят SSE/поллер",
                );
                return null;
              }
              if (verdict === "fail") throw err;
              await new Promise((r) => setTimeout(r, PROMPT_RETRY_PAUSE_MS));
            }
          }
          throw lastErr;
        }

        const systemInstruction = await getSystemInstruction();
        const promptPromise = retryablePrompt(
          sidStr,
          parts,
          selectedModel ?? undefined,
          systemInstruction || undefined,
          sessionSignal(sidStr),
          2,
        );

        if (attachmentsOverride === undefined) set({ attachments: [] });

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
          onWatchdogTimeout: () =>
            set((s) => ({
              // There is no authoritative projection anymore: the watchdog
              // explicitly means "we could not prove the turn state".
              turnProjection: { ...s.turnProjection, [sidStr]: null },
              status: { ...s.status, [sidStr]: "stale" as SessionStatus },
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
            await get().materializeSession();
            const newSid = get().currentID;
            if (newSid && !isTmpSession(newSid)) {
              if (hadAssistantReply) {
                set({ failedSendText: text });
                if (currentAttachments.length > 0)
                  set({ attachments: currentAttachments });
                toast(
                  "info",
                  "Сессия оборвалась во время ответа. Запрос возвращён в поле ввода — отправьте повторно, если нужно.",
                );
                return;
              }
              await get().send(text, currentAttachments, actionId);
            }
          } catch (recErr) {
            set((_s) => ({ error: (recErr as Error).message }));
          }
          return;
        }
        set((s) => ({
          error: (e as Error).message,
          failedSendText: text,
          status: { ...s.status, [sidStr]: "error" },
          messages: {
            ...s.messages,
            [sidStr]: (s.messages[sidStr] ?? []).filter(
              (m) => m.id !== userMsg.id,
            ),
          },
          attachments:
            s.attachments.length === 0 ? currentAttachments : s.attachments,
        }));
        return;
      }

      await doFinalFetch();
      sessionFsm.markIdle(sidStr, requestGen);
      set((s) => {
        if (!sessionFsm.isCurrent(sidStr, requestGen)) return {};
        const currentStatus = s.status[sidStr];
        const finalStatus: SessionStatus =
          currentStatus === "error" ||
          currentStatus === "stale" ||
          currentStatus === "orphaned"
            ? currentStatus
            : "idle";
        return {
          status: { ...s.status, [sidStr]: finalStatus },
        };
      });
    },

    applyEvent: (e) => {
      if (e.type !== "message.part.delta") get().flushStreamDeltas();
      const p = e.properties;
      const sid = eventSessionId(p);
      if (sid && ACTIVITY_EVENT_TYPES.has(e.type)) turnSettle.cancel(sid);
      const handler = EVENT_HANDLERS[e.type];
      if (handler) handler({ set, get }, sid, p);
    },
  };
};
