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

function toolCompleted(part: ToolPart): boolean {
  const state = part.state;
  const status =
    typeof state === "string"
      ? state
      : state && typeof state === "object"
        ? state.status
        : undefined;
  return (
    status === "completed" ||
    status === "success" ||
    (status == null && part.output != null)
  );
}

/**
 * Файлы, созданные стандартным инструментом Write. Это не новая копия:
 * карточка ведёт к тому же объекту в workspace текущей сессии.
 * Артефакты из Bash дополнительно приходят отдельной 📎-строкой по инструкции
 * модели, поэтому также становятся файл-карточками через PartView.
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
    // Только write создаёт новый файл гарантированно. edit меняет уже
    // существующий файл и не должен каждый раз засорять ответ новой карточкой.
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
  // Действия «изменить»/«перегенерировать» берём из стора напрямую: memo-сравнение
  // сообщений (sameMessageItems) игнорирует остальные пропсы, поэтому колбэки
  // через props могли бы «застыть» на старой версии.
  const editAndResend = useStore((s) => s.editAndResend);
  const regenerate = useStore((s) => s.regenerate);
  const sessionBusy = useStore(
    (s) => (s.currentID ? s.status[s.currentID] : undefined) === "busy",
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // Правку открывают, чтобы сразу дописать текст, поэтому поле должно быть
  // в фокусе. Атрибут autoFocus запрещён (a11y), ref-колбэк с постоянной
  // ссылкой срабатывает ровно при появлении поля, а не на каждый рендер.
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

  // Служебный блок вложений в буфер обмена не идёт — см. visibleMessageText.
  const combinedText = msgArray
    .map((m) => getVisibleText(m))
    .filter(Boolean)
    .join("\n\n");

  const createdAt = firstMsg?.time?.created
    ? new Date(firstMsg.time.created)
    : null;

  // Группа пользователя может содержать несколько сообщений — редактируем
  // последнее: именно оно и всё после него уйдёт при перезапросе.
  const lastUserMsg = isUser ? msgArray[msgArray.length - 1] : undefined;

  // Подписи над сообщением нет — как и над ответом агента. Выключка вправо и
  // пузырь уже говорят, чья это реплика. Убрать «АГЕНТ», но оставить «ВЫ»
  // было бы половиной решения: подписи осмысленны только парой.
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
            // Файл приходит и структурной attachment/file-частью, и ссылкой
            // в манифесте (у картинок есть обе: часть — для vision, ссылка —
            // для пути в workspace). Чип рисуем один.
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
                        // Ctrl/Cmd+Enter отправляет: обычный Enter должен
                        // оставаться переносом строки в многострочном запросе.
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
                        className="rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => setEditingId(null)}
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        className="rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
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
            <div className="mt-0.5 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100 group-hover:opacity-60 mr-1">
              {lastUserMsg && (
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title="Изменить сообщение и перезапросить ответ"
                  aria-label="Изменить сообщение"
                  disabled={sessionBusy}
                  onClick={() => {
                    // Строки-вложения (📎 …) — служебные, в поле правки не идут.
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

  // Ответ агента идёт свободным текстом: без пузыря, без подписи и без линии
  // слева. Кто говорит, видно по выключке — пользователь справа в пузыре,
  // агент слева во всю колонку, — и подпись повторяла уже сказанное. Так же
  // устроены Gemini и ChatGPT.
  return (
    <div className="group oc-msg-in flex flex-col gap-1.5 px-3 py-1 md:px-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="min-w-0 space-y-1">
          {/* Ошибка привязана к своему сообщению: она про конкретный ход,
              а не про весь ответ. */}
          {msgArray.map((message, msgIdx) =>
            message.info?.error ? (
              // `MessageAborted` — не API-ошибка: это пользовательский «Стоп».
              // В старой истории он встречается и у question fallback; такие
              // сообщения оставляем читаемыми, но новые ответы question abort
              // больше не создают.
              isAbortedError(message.info.error) ? (
                <div
                  key={`err:${message.id || msgIdx}`}
                  className="mb-2 text-xs text-muted-foreground"
                >
                  {hasQuestionPart(message)
                    ? "Старый ход был прерван при ответе на вопрос"
                    : "Ход остановлен"}
                </div>
              ) : (
                <div
                  key={`err:${message.id || msgIdx}`}
                  className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400 mb-2"
                >
                  {errorMessage(message.info.error) ??
                    "Ошибка API: проверьте тариф модели или ключ"}
                </div>
              )
            ) : null,
          )}

          {/* Одна цепочка на весь ход, а не по одной на сообщение. Движок
              присылает ход порциями, и на каждой границе цепочка обрывалась:
              в ленте шли подряд «Действия · 2 шага», «Действия · 3 шага» без
              единого слова текста между ними. Для читателя это один заход
              агента — см. `flowParts` в messageFlow.ts. */}
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
              // Подряд идущие действия (инструменты + размышления)
              // схлопываются в цепочки; текст между ними виден всегда.
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
                    // Хвост последнего сообщения во время генерации:
                    // сюда идёт стрим-курсор и авто-раскрытие цепочки.
                    // Цепочка теперь одна на весь ход, поэтому хвост
                    // — это просто её последний элемент.
                    const isTail = !!isWorking && i === flow.length - 1;
                    if ((fi as ActivityRun).kind === "activity") {
                      const run = fi as ActivityRun;
                      const first = run.items[0];
                      const tools = runToolParts(run.items);
                      const anyRunning = tools.some((t) => {
                        const s = toolStatus(t);
                        return s === "running" || s === "pending";
                      });
                      // Старые question-fallback части могли остаться в
                      // `error` после abort. Не красим их как поломку; новые
                      // ответы через Question API завершаются обычным completed.
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

        {/* Arena-style Footer: Avatar and Copy Button */}
        <div className="flex items-center gap-1.5 mt-0.5 pl-1">
          {combinedText && (
            <div className="oc-reveal flex items-center gap-1 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100">
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
          {createdAt && (
            <span
              className="text-[11px] text-muted-foreground/70"
              title={createdAt.toLocaleString("ru-RU")}
            >
              {createdAt.toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
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
