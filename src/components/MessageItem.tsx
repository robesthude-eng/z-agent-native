import { memo, useCallback, useState } from "react";
import { errorMessage, isAbortedError } from "../api/eventGuards";
import {
  hasQuestionPart,
  isInterruptedQuestionPart,
} from "../api/interruptions";
import type { Message, Part, ToolPart } from "../api/types";
import { extractAttachments } from "../lib/attachments";
import {
  messageText as getMessageText,
  visibleMessageText as getVisibleText,
} from "../lib/chatText";
import { wasStoppedByUser } from "../lib/stopUx";
import { toWorkspaceRelPath } from "../lib/workspacePath";
import { useStore } from "../store/useStore";
import AgentActivity from "./AgentActivity";
import { AttachmentChip, WorkspaceFileChip } from "./AttachmentChip";
import CopyButton from "./CopyButton";
import { NewChatIcon, RefreshIcon } from "./icons";
import {
  type ActivityRun,
  flowParts,
  groupActivityRuns,
  groupParts,
  itemKey,
  partKey,
  type RenderItem,
  runStepCount,
  runToolParts,
  type ToolGroupData,
  toolStatus,
} from "./messageFlow";
import PartView from "./PartView";
import ToolGroup from "./ToolGroup";
import UserMessageText from "./UserMessageText";

type TaskOutcomeStatus =
  | "completed"
  | "partial"
  | "needs_input"
  | "failed"
  | "cancelled";

function taskOutcomeStatus(message: Message): TaskOutcomeStatus | null {
  const raw = (
    message.info as
      | ({ outcome?: { status?: unknown } } & Record<string, unknown>)
      | undefined
  )?.outcome?.status;
  return raw === "completed" ||
    raw === "partial" ||
    raw === "needs_input" ||
    raw === "failed" ||
    raw === "cancelled"
    ? raw
    : null;
}

function toolStateStatus(part: ToolPart): string | undefined {
  const state = part.state;
  return typeof state === "string"
    ? state
    : state && typeof state === "object"
      ? state.status
      : undefined;
}

function toolCompleted(part: ToolPart): boolean {
  const status = toolStateStatus(part);
  return (
    status === "completed" ||
    status === "success" ||
    (status == null && part.output != null)
  );
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} мин ${rest} с` : `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} ч ${restMinutes} мин` : `${hours} ч`;
}

function toolInput(part: ToolPart): Record<string, unknown> | null {
  const state = part.state;
  const input =
    state && typeof state === "object" ? state.input : part.input;
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : null;
}

function addWorkspacePath(paths: Set<string>, raw: unknown) {
  if (typeof raw !== "string") return;
  const path = toWorkspaceRelPath(raw);
  if (path) paths.add(path);
}

function assistantTurnSummary(messages: Message[]) {
  let startedAt: number | null = null;
  let completedAt: number | null = null;
  let failed = false;
  let stopped = false;
  let needsInput = false;
  let outcomeStatus: TaskOutcomeStatus | null = null;
  let anonymousAction = 0;
  const actions = new Set<string>();
  const changedFiles = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const start = message.time?.created ?? message.info?.time?.created;
    const end = message.time?.completed ?? message.info?.time?.completed;
    if (typeof start === "number") {
      startedAt = startedAt == null ? start : Math.min(startedAt, start);
    }
    if (typeof end === "number") {
      completedAt = completedAt == null ? end : Math.max(completedAt, end);
    }
    const explicitOutcome = taskOutcomeStatus(message);
    if (explicitOutcome) outcomeStatus = explicitOutcome;
    if (message.info?.error) {
      if (isAbortedError(message.info.error)) stopped = true;
      else failed = true;
    }
    if (wasStoppedByUser(message)) stopped = true;

    for (const part of message.parts ?? []) {
      if (part.type !== "tool") continue;
      const toolPart = part as ToolPart;
      const tool = String(toolPart.tool || "").toLowerCase();
      const toolStatus = toolStateStatus(toolPart);
      if (
        tool === "question" &&
        (toolStatus === "running" ||
          toolStatus === "pending" ||
          toolStatus === "waiting")
      ) {
        needsInput = true;
      }
      actions.add(
        toolPart.callID || toolPart.id || `${message.id}:tool:${anonymousAction++}`,
      );
      if (!toolCompleted(toolPart)) continue;
      const input = toolInput(toolPart);
      if (!input) continue;

      if (tool === "write" || tool === "edit") {
        addWorkspacePath(changedFiles, input.path ?? input.filePath);
      }
      if (tool === "apply_patch" || tool === "applypatch" || tool === "patch") {
        const patch = input.patch;
        if (typeof patch === "string") {
          for (const line of patch.split("\n")) {
            if (!line.startsWith("+++ ")) continue;
            let path = line.slice(4).trim().split("\t")[0] || "";
            if (!path || path === "/dev/null") continue;
            path = path.replace(/^b\//, "");
            addWorkspacePath(changedFiles, path);
          }
        }
      }
    }
  }

  const durationMs =
    startedAt != null && completedAt != null && completedAt >= startedAt
      ? completedAt - startedAt
      : null;

  return {
    failed,
    stopped,
    needsInput,
    outcomeStatus,
    durationMs,
    actionCount: actions.size,
    changedFileCount: changedFiles.size,
  };
}

function turnSummaryLabel(turnMeta: ReturnType<typeof assistantTurnSummary>): string {
  if (turnMeta.stopped || turnMeta.outcomeStatus === "cancelled") {
    return "Остановлено пользователем";
  }
  if (turnMeta.needsInput || turnMeta.outcomeStatus === "needs_input") {
    return "Нужны данные";
  }
  if (turnMeta.outcomeStatus === "partial") return "Частично выполнено";
  if (turnMeta.outcomeStatus === "failed") return "Ошибка";
  if (turnMeta.outcomeStatus === "completed") return "Готово";
  return turnMeta.failed ? "Ошибка" : "Готово";
}

/**
 * Файлы, созданные стандартным инструментом Write. Это не новая копия:
 * карточка ведёт к тому же объекту в workspace текущей сессии.
 */
function GeneratedFiles({ message }: { message: Message }) {
  const pathsInText = new Set<string>();
  for (const p of message.parts || []) {
    if (p.type !== "text" || typeof (p as { text?: unknown }).text !== "string")
      continue;
    const text = (p as { text: string }).text;
    for (const m of text.matchAll(/^📎 .+? → (\S+)/gm)) {
      const path = toWorkspaceRelPath(m[1] || "");
      if (path) pathsInText.add(path);
    }
  }

  const files = new Map<string, string>();
  for (const p of message.parts || []) {
    if (p.type !== "tool") continue;
    const tool = String((p as ToolPart).tool || "").toLowerCase();
    if (tool !== "write" || !toolCompleted(p as ToolPart)) continue;
    const state = (p as ToolPart).state;
    const input =
      state && typeof state === "object" ? state.input : (p as ToolPart).input;
    if (!input || typeof input !== "object") continue;
    const raw =
      (input as Record<string, unknown>).filePath ??
      (input as Record<string, unknown>).path;
    if (typeof raw !== "string") continue;
    const path = toWorkspaceRelPath(raw);
    if (!path || pathsInText.has(path)) continue;
    const name = path.split("/").pop() || path;
    files.set(path, name);
  }

  if (files.size === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {[...files].map(([path, name]) => (
        <WorkspaceFileChip
          key={path}
          name={name}
          path={path}
          meta="Создано ассистентом · в workspace"
        />
      ))}
    </div>
  );
}

function MessageItem({
  messages,
  isWorking,
}: {
  messages: Message | Message[];
  isWorking?: boolean;
}) {
  const editAndResend = useStore((s) => s.editAndResend);
  const regenerate = useStore((s) => s.regenerate);
  const sessionBusy = useStore(
    (s) => (s.currentID ? s.status[s.currentID] : undefined) === "busy",
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [errorDetailsId, setErrorDetailsId] = useState<string | null>(null);
  const focusEditor = useCallback((el: HTMLTextAreaElement | null) => {
    el?.focus();
  }, []);

  const msgArray = Array.isArray(messages) ? messages : [messages];
  const firstMsg = msgArray[0];
  const role =
    firstMsg?.role ||
    (firstMsg?.info?.role as string | undefined) ||
    "assistant";
  const isUser = role === "user";

  const combinedText = msgArray
    .map((m) => getVisibleText(m))
    .filter(Boolean)
    .join("\n\n");

  const createdAt = firstMsg?.time?.created
    ? new Date(firstMsg.time.created)
    : null;
  const turnMeta = !isUser ? assistantTurnSummary(msgArray) : null;
  const summaryBits: string[] = [];
  if (!isUser && !isWorking && turnMeta) {
    summaryBits.push(turnSummaryLabel(turnMeta));
    if (turnMeta.durationMs != null) summaryBits.push(formatDuration(turnMeta.durationMs));
    if (turnMeta.actionCount > 0) {
      summaryBits.push(
        `${turnMeta.actionCount} ${pluralRu(turnMeta.actionCount, "действие", "действия", "действий")}`,
      );
    }
    if (turnMeta.changedFileCount > 0) {
      summaryBits.push(
        `${turnMeta.changedFileCount} ${pluralRu(turnMeta.changedFileCount, "файл", "файла", "файлов")}`,
      );
    }
  }

  const lastUserMsg = isUser ? msgArray[msgArray.length - 1] : undefined;

  if (isUser) {
    return (
      <div className="group oc-msg-in flex flex-col items-end gap-1 px-3 py-1 md:px-6">
        <div className="flex min-w-0 flex-col gap-1 items-end max-w-full">
          {msgArray.map((message, idx) => {
            const msgText = getMessageText(message);
            const { refs, rest } = extractAttachments(msgText);
            const realAttParts = (message.parts || []).filter(
              (p) => p.type === "attachment" || p.type === "file",
            );
            const attPartNames = new Set(
              realAttParts
                .map((p) => {
                  const f = p as { name?: unknown; filename?: unknown };
                  const n = typeof f.name === "string" ? f.name : f.filename;
                  return typeof n === "string" ? n : "";
                })
                .filter(Boolean),
            );
            const uniqueRefs = refs.filter((r) => !attPartNames.has(r.name));
            const isEditing = editingId === message.id;
            return (
              <div
                key={message.id || idx}
                className="flex w-full flex-col gap-1 max-w-[min(100%,700px)] self-end items-end"
              >
                {(uniqueRefs.length > 0 || realAttParts.length > 0) && (
                  <div className="flex flex-wrap gap-2 justify-end">
                    {uniqueRefs.map((r) => (
                      <AttachmentChip key={r.path || r.name} file={r} />
                    ))}
                    {realAttParts.map((part) => (
                      <PartView key={partKey(part)} part={part} />
                    ))}
                  </div>
                )}
                {isEditing ? (
                  <div className="flex w-[min(78vw,700px)] flex-col gap-2 text-left">
                    <textarea
                      ref={focusEditor}
                      className="min-h-[88px] w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-[14.5px] leading-relaxed text-foreground outline-none focus:border-primary/50"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditingId(null);
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          setEditingId(null);
                          editAndResend(message.id, editText).catch(() => {});
                        }
                      }}
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="min-h-9 rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => setEditingId(null)}
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        className="min-h-9 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                        disabled={!editText.trim() || sessionBusy}
                        onClick={() => {
                          setEditingId(null);
                          editAndResend(message.id, editText).catch(() => {});
                        }}
                      >
                        Отправить заново
                      </button>
                    </div>
                  </div>
                ) : (
                  (rest ||
                    (refs.length === 0 && realAttParts.length === 0)) && (
                    <UserMessageText text={rest || "…"} />
                  )
                )}
              </div>
            );
          })}
          {combinedText && !editingId && (
            <div className="mt-0.5 mr-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100 group-hover:opacity-60">
              {lastUserMsg && (
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="Изменить сообщение и перезапросить ответ"
                  aria-label="Изменить сообщение"
                  disabled={sessionBusy}
                  onClick={() => {
                    setEditText(
                      extractAttachments(getMessageText(lastUserMsg)).rest,
                    );
                    setEditingId(lastUserMsg.id);
                  }}
                >
                  <NewChatIcon size={14} />
                </button>
              )}
              <CopyButton
                text={combinedText}
                title="Копировать"
                className="h-7 w-7"
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  const failedSummary =
    turnMeta?.outcomeStatus === "failed" ||
    (turnMeta?.failed === true && turnMeta?.outcomeStatus !== "partial");

  return (
    <div className="group oc-msg-in flex flex-col gap-1.5 px-3 py-1 md:px-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="min-w-0 space-y-1">
          {msgArray.map((message, msgIdx) => {
            if (!message.info?.error) return null;
            const aborted = isAbortedError(message.info.error);
            if (aborted) {
              return (
                <div
                  key={`err:${message.id || msgIdx}`}
                  className="mb-2 text-xs text-muted-foreground"
                >
                  {hasQuestionPart(message)
                    ? "Старый ход был прерван при ответе на вопрос"
                    : "Остановлено пользователем"}
                </div>
              );
            }

            const detail =
              errorMessage(message.info.error) ??
              "Провайдер не смог завершить этот ответ.";
            const detailsOpen = errorDetailsId === message.id;
            return (
              <div
                key={`err:${message.id || msgIdx}`}
                className="mb-2 rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-2.5 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-red-300">
                    Не удалось завершить ответ
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="min-h-9 rounded-full px-2.5 text-muted-foreground transition hover:bg-red-500/10 hover:text-foreground disabled:opacity-40"
                      disabled={sessionBusy}
                      onClick={() => regenerate(message.id).catch(() => {})}
                    >
                      Повторить
                    </button>
                    <button
                      type="button"
                      className="min-h-9 rounded-full px-2.5 text-muted-foreground transition hover:bg-red-500/10 hover:text-foreground"
                      aria-expanded={detailsOpen}
                      onClick={() =>
                        setErrorDetailsId(detailsOpen ? null : message.id)
                      }
                    >
                      Подробнее
                    </button>
                  </div>
                </div>
                {detailsOpen && (
                  <div className="mt-2 break-words rounded-lg bg-background/50 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {detail}
                  </div>
                )}
              </div>
            );
          })}

          <div className="text-[14.5px] leading-relaxed text-foreground/95">
            {(() => {
              const items = groupParts(flowParts(msgArray));
              const attParts = items.filter(
                (item) =>
                  "type" in item &&
                  (item.type === "attachment" || item.type === "file"),
              );
              const otherParts = items.filter(
                (item) =>
                  !("type" in item) ||
                  (item.type !== "attachment" && item.type !== "file"),
              );
              const flow = groupActivityRuns(otherParts);
              const renderFlowPart = (item: RenderItem, streaming: boolean) => {
                const g = item as ToolGroupData;
                if ("kind" in g && g.kind === "group") {
                  return (
                    <ToolGroup
                      key={itemKey(item)}
                      tool={g.tool}
                      parts={g.parts}
                    />
                  );
                }
                return (
                  <PartView
                    key={itemKey(item)}
                    part={item as Part}
                    {...(streaming ? { isLastStreaming: true } : {})}
                  />
                );
              };
              return (
                <>
                  {attParts.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {attParts.map((item) => (
                        <PartView
                          key={partKey(item as Part)}
                          part={item as Part}
                        />
                      ))}
                    </div>
                  )}
                  {flow.map((fi, i) => {
                    const isTail = !!isWorking && i === flow.length - 1;
                    if ((fi as ActivityRun).kind === "activity") {
                      const run = fi as ActivityRun;
                      const first = run.items[0];
                      const tools = runToolParts(run.items);
                      const anyRunning = tools.some((t) => {
                        const s = toolStatus(t);
                        return s === "running" || s === "pending";
                      });
                      const hasError = tools.some(
                        (t) =>
                          toolStatus(t) === "error" &&
                          !isInterruptedQuestionPart(t),
                      );
                      return (
                        <AgentActivity
                          key={`act:${first ? itemKey(first) : i}`}
                          count={runStepCount(run.items)}
                          running={anyRunning || isTail}
                          hasError={hasError}
                        >
                          {run.items.map((it, j) =>
                            renderFlowPart(
                              it,
                              isTail && j === run.items.length - 1,
                            ),
                          )}
                        </AgentActivity>
                      );
                    }
                    return renderFlowPart(fi as RenderItem, isTail);
                  })}
                </>
              );
            })()}
          </div>

          {msgArray.map((message, msgIdx) => (
            <GeneratedFiles
              key={`gen:${message.id || msgIdx}`}
              message={message}
            />
          ))}
        </div>

        <div className="mt-1 flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-1">
          {!isWorking && summaryBits.length > 0 && (
            <span
              className={`text-[11px] ${failedSummary ? "text-red-400/85" : "text-muted-foreground/70"}`}
              title={createdAt?.toLocaleString("ru-RU")}
            >
              {summaryBits.join(" · ")}
            </span>
          )}
          {combinedText && (
            <div className="oc-reveal ml-auto flex items-center gap-1 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100">
              <CopyButton
                text={combinedText}
                title="Копировать сообщение"
                className="h-7 w-7"
              />
              {firstMsg && !isWorking && (
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="Перегенерировать ответ"
                  aria-label="Перегенерировать ответ"
                  disabled={sessionBusy}
                  onClick={() => {
                    regenerate(firstMsg.id).catch(() => {});
                  }}
                >
                  <RefreshIcon size={14} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function isValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function sameMessageItems(
  prev: { messages: Message | Message[]; isWorking?: boolean },
  next: { messages: Message | Message[]; isWorking?: boolean },
): boolean {
  if (prev.isWorking !== next.isWorking) return false;
  const prevList = Array.isArray(prev.messages)
    ? prev.messages
    : [prev.messages];
  const nextList = Array.isArray(next.messages)
    ? next.messages
    : [next.messages];
  if (prevList.length !== nextList.length) return false;

  for (let i = 0; i < prevList.length; i++) {
    const pMsg = prevList[i];
    const nMsg = nextList[i];
    if (!pMsg || !nMsg) return pMsg === nMsg;
    if (pMsg === nMsg) continue;
    if (
      pMsg.id !== nMsg.id ||
      pMsg.role !== nMsg.role ||
      !isValueEqual(pMsg.time, nMsg.time) ||
      !isValueEqual(pMsg.info, nMsg.info) ||
      (pMsg.parts?.length ?? 0) !== (nMsg.parts?.length ?? 0)
    ) {
      return false;
    }
    const pParts = pMsg.parts ?? [];
    const nParts = nMsg.parts ?? [];
    for (let j = 0; j < pParts.length; j++) {
      const pPart = pParts[j];
      const nPart = nParts[j];
      if (!pPart || !nPart) return pPart === nPart;
      if (pPart === nPart) continue;
      if (
        pPart.id !== nPart.id ||
        pPart.type !== nPart.type ||
        !isValueEqual(
          (pPart as { text?: unknown }).text,
          (nPart as { text?: unknown }).text,
        ) ||
        !isValueEqual(
          (pPart as { output?: unknown }).output,
          (nPart as { output?: unknown }).output,
        ) ||
        !isValueEqual(
          (pPart as { reasoning?: unknown }).reasoning,
          (nPart as { reasoning?: unknown }).reasoning,
        ) ||
        !isValueEqual(
          (pPart as { status?: unknown }).status,
          (nPart as { status?: unknown }).status,
        ) ||
        !isValueEqual(
          (pPart as { state?: unknown }).state,
          (nPart as { state?: unknown }).state,
        ) ||
        !isValueEqual(
          (pPart as { tool?: unknown }).tool,
          (nPart as { tool?: unknown }).tool,
        ) ||
        !isValueEqual(
          (pPart as { callID?: unknown }).callID,
          (nPart as { callID?: unknown }).callID,
        ) ||
        !isValueEqual(
          (pPart as { input?: unknown }).input,
          (nPart as { input?: unknown }).input,
        ) ||
        !isValueEqual(
          (pPart as { name?: unknown }).name,
          (nPart as { name?: unknown }).name,
        ) ||
        !isValueEqual(
          (pPart as { size?: unknown }).size,
          (nPart as { size?: unknown }).size,
        ) ||
        !isValueEqual(
          (pPart as { kind?: unknown }).kind,
          (nPart as { kind?: unknown }).kind,
        ) ||
        !isValueEqual(
          (pPart as { path?: unknown }).path,
          (nPart as { path?: unknown }).path,
        ) ||
        !isValueEqual(
          (pPart as { dataUrl?: unknown }).dataUrl,
          (nPart as { dataUrl?: unknown }).dataUrl,
        ) ||
        !isValueEqual(
          (pPart as { filename?: unknown }).filename,
          (nPart as { filename?: unknown }).filename,
        ) ||
        !isValueEqual(
          (pPart as { url?: unknown }).url,
          (nPart as { url?: unknown }).url,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

export default memo(MessageItem, sameMessageItems);
