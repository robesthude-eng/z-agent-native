import { BorderBeam } from "border-beam";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t, tf } from "@/i18n";
import { cn } from "@/lib/utils";
import { api } from "../api/client";
import { statusText } from "../api/eventGuards";
import { formatSize, MAX_UPLOAD_BYTES, processFile } from "../api/files";
import {
  enqueuePlan,
  fallbackToLocal,
  mergeQueue,
  nextToSend,
  parseServerQueue,
  type QueueEntry,
  removalPlan,
  serverQueueEnabled,
} from "../api/sendQueue";
import { dispositionOf, sendBlockReason } from "../api/turnVerdict";
import { messageText } from "../lib/chatText";
import { sessionActionPrep } from "../lib/ids";
import { useStore } from "../store/useStore";
import { ComposerAttachments } from "./composer/ComposerAttachments";
import { ComposerDropOverlay } from "./composer/ComposerDropOverlay";
import { ComposerQueue } from "./composer/ComposerQueue";
import { ComposerSuggestions } from "./composer/ComposerSuggestions";
import { useComposerSuggestions } from "./composer/useComposerSuggestions";
import {
  clearSessionComposerCache,
  storeSessionAttachment,
  useSessionComposerDrafts,
} from "./composer/useSessionComposerDrafts";
import { useWindowFileDrop } from "./composer/useWindowFileDrop";
import { PaperclipIcon, SendIcon, StopIcon } from "./icons";

/**
 * Сколько сессия должна пробыть свободной, прежде чем очередь имеет право
 * отправить следующее сообщение.
 *
 * Это не «на всякий случай». Пока клиент закрывал ход по маркеру шага, здесь
 * стоял ноль — и каждое такое мнимое «свободна» превращалось в отправку в
 * работающий ход, а движок на новый промпт прерывал текущий ответ. Причину
 * чинит `src/api/turnFinality.ts`; окно оставлено потому, что цена ошибки
 * несимметрична: лишняя секунда ожидания против чужого сообщения в чате.
 */
const QUEUE_SETTLE_MS = 1200;

// Этап 2.4: запись очереди — `QueueEntry` из `src/api/sendQueue.ts`, общая с
// сервером. Ключ строки — `actionId`, а не индекс: два одинаковых текста
// делили бы React-key, а крестик удалял бы не ту строку, когда очередь
// параллельно сдвигается автоотправкой. Прежний локальный `q1, q2, …` ушёл
// вместе с собственной нумерацией: ключ теперь тот же, с которым сообщение
// уйдёт, и придумывать для очереди второй нельзя.

export default function Composer() {
  const currentID = useStore((s) => s.currentID);
  const newSession = useStore((s) => s.newSession);
  const materializeSession = useStore((s) => s.materializeSession);

  /**
   * Запрет отправки, пока агент ждёт человека (этап 2.1).
   *
   * Пока агент ждёт разрешения или ответа, отправка начинала бы ВТОРОЙ ход при
   * приостановленном первом — тот разрыв непрерывности, который этап и
   * запрещает. Решение вынесено в `sendBlockReason`, а не собрано здесь: и
   * условие, и текст проверяются тестом.
   *
   * Пока оркестратор выключен, проекции нет и запрета тоже — поведение остаётся
   * прежним.
   */
  const turnProjection = useStore((s) =>
    currentID ? (s.turnProjection[currentID] ?? null) : null,
  );
  const blockedReason = sendBlockReason(
    turnProjection ? dispositionOf(turnProjection) : null,
  );
  const rawStatus = useStore((s) =>
    currentID ? s.status[currentID] : undefined,
  );
  const status = statusText(rawStatus);
  const send = useStore((s) => s.send);
  const abort = useStore((s) => s.abort);
  const attachments = useStore((s) => s.attachments);
  const addAttachments = useStore((s) => s.addAttachments);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const clearAttachments = useStore((s) => s.clearAttachments);
  const failedSendText = useStore((s) => s.failedSendText);
  const clearFailedSendText = useStore((s) => s.clearFailedSendText);
  const [text, setText] = useState("");
  // P2-fix: очередь сообщений — набранное во время генерации не теряется,
  // а отправляется автоматически, как только сессия освободится.
  const [queued, setQueued] = useState<QueueEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
    {},
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  /*
    Отказ отправки — не ошибка загрузки файла. Причина («агент ждёт
    ответа») печаталась красным в том же канале, что и сбой вложения,
    и читалась как поломка приложения.
  */
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);

  const busy =
    status === "busy" ||
    status === "retry" ||
    status === "stale" ||
    status === "orphaned" ||
    status === "submitting" ||
    status === "running";

  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  useEffect(() => {
    if (!text && textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text]);

  // P2-fix: отправка упала — возвращаем текст в поле ввода, чтобы
  // пользователь не набирал его заново.
  useEffect(() => {
    if (failedSendText) {
      setText((t) => (t ? `${t}\n${failedSendText}` : failedSendText));
      clearFailedSendText();
    }
  }, [failedSendText, clearFailedSendText]);

  useSessionComposerDrafts({
    sessionId: currentID,
    text,
    attachments,
    setText,
    addAttachments,
    clearAttachments,
  });

  // Сессия освободилась — отправляем следующее из очереди.
  //
  // Три предохранителя, и каждый закрывает случай, который уже случался.
  //
  // 1. `sendingRef` — пока предыдущая автоотправка не вернулась, вторая не
  //    начинается. Прежнее «send() ставит busy синхронно» верно только для
  //    существующей сессии: черновик сначала материализуется, и до первого
  //    `set(busy)` эффект успевал слить в движок всю очередь разом.
  // 2. `sentRef` — один `actionId` уходит ровно один раз. Запись, вернувшаяся
  //    из серверной очереди после неудавшегося изъятия, больше не отправляется
  //    повторно.
  // 3. Окно тишины — очередь трогается только после того, как сессия побыла
  //    свободной `QUEUE_SETTLE_MS`. Мгновенное «свободна» посреди хода было
  //    корнем всей истории; окно оставляет защиту и на случай, если такой
  //    сигнал появится снова.
  //
  // Изъятие идёт ПОСЛЕ решения об отправке и по той же причине, по которой
  // разделены чтение и изъятие на сервере: убрать запись раньше — значит
  // потерять сообщение при обрыве между изъятием и отправкой.
  const sendingRef = useRef(false);
  const sentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (busy || sendingRef.current) return;
    const next = nextToSend(queued, busy);
    if (!next) return;
    if (sentRef.current.has(next.actionId)) {
      setQueued((q) => q.filter((e) => e.actionId !== next.actionId));
      return;
    }
    const timer = setTimeout(() => {
      // Состояние перечитывается в момент срабатывания, а не берётся из
      // замыкания: за время окна пользователь мог нажать «Стоп», очистить
      // очередь или отправить сообщение сам.
      if (sendingRef.current) return;
      if (useStore.getState().currentID !== currentID) return;
      sendingRef.current = true;
      sentRef.current.add(next.actionId);
      setQueued((q) => q.filter((e) => e.actionId !== next.actionId));
      if (next.origin === "server" && currentID) {
        api.dequeueAction(currentID, next.actionId).catch(() => {});
      }
      send(next.text, next.attachments ?? [], next.actionId)
        .catch(() => {})
        .finally(() => {
          sendingRef.current = false;
        });
    }, QUEUE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [busy, queued, send, currentID]);

  // Переключение чата не должно тащить за собой чужую автоотправку.
  // Зависимость намеренная: currentID — это триггер, тело намеренно его не
  // читает (ref не требует его в замыкании), а не «лишняя» зависимость.
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentID — триггер сброса sentRef при переключении сессии
  useEffect(() => {
    sentRef.current = new Set();
  }, [currentID]);

  // Источник очереди — сервер (этап 2.4, флаг `VITE_SERVER_QUEUE`). Очередь
  // хранится по сессии, поэтому «источник — сервер» делает её общей для
  // вкладок сам собой: это то же требование I-10, только про очередь.
  const refreshQueue = useCallback(async () => {
    if (!serverQueueEnabled()) return;
    if (sessionActionPrep(currentID) !== "ready" || !currentID) return;
    try {
      const body = await api.listQueue(currentID);
      const server = parseServerQueue(body);
      setQueued((local) => mergeQueue(server, local));
    } catch {
      // Сервер молчит — остаётся то, что уже показано. Опустошить список
      // здесь значило бы спрятать сообщения пользователя из-за сетевой
      // ошибки, а очередь заводилась ровно затем, чтобы этого не было.
    }
  }, [currentID]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const submit = async () => {
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    // Проверка стоит в действии, а не только на кнопке: Enter вызывает submit()
    // напрямую, и неактивная кнопка его не останавливает. Показываем причину —
    // молчаливый отказ на Enter выглядел бы поломкой ввода.
    if (blockedReason) {
      setBlockedNotice(blockedReason);
      setTimeout(() => setBlockedNotice(null), 6000);
      return;
    }
    // P2-fix: во время генерации Enter не теряет сообщение,
    // а ставит его в очередь.
    if (busy) {
      if (value || attachments.length > 0) {
        const plan = enqueuePlan(value, currentID, {
          attachments,
        });
        const queuedAttachments = plan.attachments;
        // Запись появляется в списке СРАЗУ и как локальная, независимо от
        // пути. Ждать ответа сервера, чтобы показать своё же сообщение,
        // значило бы на время потерять его из вида; слияние по `actionId`
        // не даст ему задвоиться, когда подтверждение придёт.
        setQueued((q) => [
          ...q,
          {
            actionId: plan.actionId,
            text: value,
            attachments: queuedAttachments,
            position: null,
            origin: "local",
          },
        ]);
        setText("");
        clearAttachments();
        if (currentID) clearSessionComposerCache(currentID);
        if (plan.kind === "server") {
          api
            .enqueueAction(
              plan.sessionId,
              plan.actionId,
              plan.text,
              plan.attachments,
            )
            .then(() => refreshQueue())
            .catch(() => {
              // Недоступность очереди — не повод отказать: запись уже лежит
              // локально и уйдёт прежним путём. Ровно это и означает
              // `fallbackToLocal`, вызванный здесь ради одной цели —
              // чтобы решение было видно, а не подразумевалось.
              fallbackToLocal(plan);
            });
        }
      }
      return;
    }
    setText("");
    if (currentID) {
      clearSessionComposerCache(currentID);
    }
    await send(value);
  };

  const handleFiles = async (fileList: FileList | File[] | null) => {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    // Отсекаем негабарит до отправки байтов: сервер всё равно ответит 413,
    // но уже после полной закачки.
    const tooBig = incoming.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const accepted = incoming.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (tooBig.length > 0) {
      const names = tooBig.map((f) => `${f.name} (${formatSize(f.size)})`);
      setUploadError(
        tf("composer.slishkom_bolshoy_fayl_maksimum_0_1", [
          formatSize(MAX_UPLOAD_BYTES),
          names.join(", "),
        ]),
      );
      setTimeout(() => setUploadError(null), 8000);
    }
    if (accepted.length === 0) return;

    // Прикрепление файла — действие, а действие материализует сессию (I-21).
    // Почему «завести чат» и «довести черновик» — разные исходы и почему их
    // легко перепутать, разобрано в докблоке sessionActionPrep (src/lib/ids.ts).
    //
    // Состояние читается из стора, а не из currentID замыкания: обработчик
    // асинхронный, и к моменту второй проверки значение из замыкания устарело
    // бы дважды — после newSession() и после переключения чата пользователем.
    if (sessionActionPrep(useStore.getState().currentID) === "create") {
      // Чата нет вовсе: сперва оптимистичный, потом настоящий. Здесь
      // newSession() уместна — терять нечего.
      await newSession();
    }
    if (sessionActionPrep(useStore.getState().currentID) === "materialize") {
      await materializeSession();
    }
    const sid = useStore.getState().currentID;
    if (!sid || sessionActionPrep(sid) !== "ready") {
      // Сюда попадаем, только если создание сессии не удалось:
      // materializeSession() уже откатила оптимистичный чат и записала error.
      setUploadError(t("composer.ne_udalos_sozdat_chat_dlya_zagruzki"));
      setTimeout(() => setUploadError(null), 6000);
      return;
    }

    // Уникальность имени обеспечивает СЕРВЕР (resolveUniqueName): только он
    // видит уже загруженные файлы, параллельные вкладки и другие клиенты.
    // Здесь показываем исходное имя, а после ответа заменяем на каноническое.
    const queue = accepted;
    for (const f of queue) {
      setUploadProgress((p) => ({ ...p, [f.name]: 0 }));
    }

    // Параллельно: последовательный await заставлял пятый файл ждать
    // загрузки первых четырёх, хотя канал простаивал.
    await Promise.all(
      queue.map(async (file) => {
        const name = file.name;
        try {
          const result = await api.uploadFile(
            file,
            (pct) => {
              setUploadProgress((p) => ({ ...p, [name]: pct }));
            },
            sid,
          );
          const processed = await processFile(file);
          // Каноническое имя от сервера: при коллизии оно отличается от
          // отправленного, и дальше везде должно использоваться именно оно.
          if (result.name) {
            processed.serverName = result.name;
            processed.name = result.name;
          }
          processed.uploadedPath = result.path;
          processed.workspacePath =
            result.workspacePath ?? `uploads/${processed.name}`;
          if (result.agentPath) processed.agentPath = result.agentPath;
          if (typeof result.entryCount === "number") {
            processed.entryCount = result.entryCount;
          }
          if (useStore.getState().currentID === sid) {
            addAttachments([processed]);
          } else {
            // The user changed chats while the upload was in flight. Keep the
            // result with the workspace that received its bytes; putting it in
            // the active global attachment array would forge a path in the
            // newly selected chat.
            storeSessionAttachment(sid, processed);
          }
        } catch (err: unknown) {
          const msg = (err as Error)?.message || String(err);
          setUploadError(`${name}: ${msg}`);
          setTimeout(() => setUploadError(null), 6000);
        } finally {
          setUploadProgress((p) => {
            const next = { ...p };
            delete next[name];
            return next;
          });
        }
      }),
    );

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    // Оконный обработчик ниже поймал бы то же событие и загрузил файлы
    // второй раз — гасим всплытие.
    e.stopPropagation();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = () => setDragOver(false);

  const windowDrag = useWindowFileDrop(
    (files) => {
      void handleFiles(files);
    },
    () => setDragOver(false),
  );

  /*
    Остановка хода вынесена из onClick: тот же сценарий нужен по Esc, а
    два независимых места со снятием очереди неизбежно разошлись бы:
    кнопка чистит очередь, клавиша — нет.
  */
  const stopTurn = useCallback(() => {
    for (const q of queued) {
      const plan = removalPlan(q, currentID);
      if (plan.kind === "server") {
        api.dequeueAction(plan.sessionId, plan.actionId).catch(() => {});
      }
    }
    setQueued([]);
    abort();
  }, [queued, currentID, abort]);

  const canSend =
    (text.trim().length > 0 || attachments.length > 0) && !blockedReason;

  const suggestions = useComposerSuggestions({
    sessionId: currentID,
    text,
    caret,
    setText,
    setCaret,
    textareaRef,
  });

  return (
    <div className="w-full max-w-3xl shrink-0 mx-auto px-3 md:px-6 pb-6 pointer-events-none">
      <div className="relative pointer-events-auto w-full">
        <ComposerSuggestions
          commands={suggestions.commands}
          files={suggestions.files}
          commandIndex={suggestions.commandIndex}
          fileIndex={suggestions.fileIndex}
          onCommand={suggestions.chooseCommand}
          onFile={suggestions.chooseFile}
        />

        {/* role="alert" — иначе причина неудачной отправки видна только
            глазами, а сообщение живёт всего шесть секунд. */}
        {uploadError && (
          <div
            role="alert"
            className="absolute -top-8 left-0 right-0 text-center text-xs text-red-400 animate-in fade-in slide-in-from-bottom-1"
          >
            {uploadError}
          </div>
        )}

        {blockedNotice && !uploadError && (
          <div
            role="alert"
            className="absolute -top-8 left-0 right-0 text-center text-xs text-amber-400 animate-in fade-in slide-in-from-bottom-1"
          >
            {blockedNotice}
          </div>
        )}

        <BorderBeam
          size="md"
          colorVariant="colorful"
          borderRadius={24}
          className="w-full rounded-3xl"
          active
        >
          {/* Именованная <section>, а не безымянный div: это зона приёма файлов
              (drag&drop), и у интерактивного контейнера должна быть роль. Клавиатурный
              путь для тех же файлов — кнопка «Прикрепить файл» и вставка из буфера. */}
          <section
            aria-label={t("composer.pole_vvoda_soobscheniya")}
            className={cn(
              "relative w-full transition-all duration-[200ms]",
              "bg-card/95 backdrop-blur-md rounded-3xl px-3 py-2.5 shadow-sm",
              dragOver && "ring-2 ring-primary bg-primary/5",
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <div className="flex flex-col gap-1">
              {/* P2-fix: очередь сообщений, ожидающих окончания генерации */}
              <ComposerQueue
                entries={queued}
                onRemove={(entry) => {
                  const plan = removalPlan(entry, currentID);
                  setQueued((previous) =>
                    previous.filter(
                      (message) => message.actionId !== plan.actionId,
                    ),
                  );
                  if (plan.kind === "server") {
                    api
                      .dequeueAction(plan.sessionId, plan.actionId)
                      .catch(() => {});
                  }
                }}
              />
              {/* Вложения и незавершённые загрузки — одним рядом карточек.
              Раньше это были два разных ряда безымянных «пилюль»: загрузка
              показывалась в одном месте, а готовый файл появлялся в другом,
              без иконки, размера и превью. */}
              <ComposerAttachments
                attachments={attachments}
                uploadProgress={uploadProgress}
                sessionId={currentID}
                onRemove={removeAttachment}
              />

              {/* Input area */}
              <div className="flex items-end gap-2 px-2 py-1 mt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground border border-white/10 bg-white/[0.03] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] hover:border-white/20 hover:bg-white/[0.07] transition-all"
                  onClick={() => fileInputRef.current?.click()}
                  title={t("composer.prikrepit_fayl")}
                  aria-label={t("composer.prikrepit_fayl")}
                >
                  <PaperclipIcon size={16} />
                </Button>
                <input
                  type="file"
                  multiple
                  ref={fileInputRef}
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <textarea
                  ref={textareaRef}
                  rows={1}
                  placeholder={t("composer.chto_hotite_sdelat")}
                  aria-label={t("composer.soobschenie_assistentu")}
                  className="flex-1 min-h-[40px] max-h-[200px] bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 text-foreground placeholder:text-muted-foreground resize-none py-2 text-[15px] leading-relaxed"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setCaret(e.target.selectionStart ?? e.target.value.length);
                    grow(e.target);
                  }}
                  onKeyDown={(e) => {
                    if (suggestions.commands.length > 0) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        suggestions.moveCommand(e.key === "ArrowDown" ? 1 : -1);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        if (suggestions.activeCommand) {
                          suggestions.chooseCommand(suggestions.activeCommand);
                        }
                        return;
                      }
                    }
                    if (suggestions.files.length > 0) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        suggestions.moveFile(e.key === "ArrowDown" ? 1 : -1);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        if (suggestions.activeFile) {
                          suggestions.chooseFile(suggestions.activeFile);
                        }
                        return;
                      }
                    }
                    /*
                      Esc — это «стоп». До этого прервать ход можно было только
                      кнопкой: с клавиатуры её приходилось искать табом, хотя рука
                      уже лежит на Esc.
                    */
                    if (e.key === "Escape" && busy) {
                      e.preventDefault();
                      stopTurn();
                      return;
                    }
                    /*
                      ↑ в пустом поле возвращает последнее отправленное
                      сообщение — привычка из терминала. Раньше опечатку в
                      длинном запросе приходилось набирать заново. Проверка стоит
                      ниже подсказок: пока открыт список команд или файлов,
                      ↑ принадлежит ему.
                    */
                    if (e.key === "ArrowUp" && !text) {
                      const all = currentID
                        ? useStore.getState().messages[currentID]
                        : null;
                      const last = [...(all ?? [])]
                        .reverse()
                        .find((m) => m.role === "user");
                      const restored = last ? messageText(last).trim() : "";
                      if (!restored) return;
                      e.preventDefault();
                      setText(restored);
                      requestAnimationFrame(() => {
                        const el = textareaRef.current;
                        if (!el) return;
                        const end = restored.length;
                        el.setSelectionRange(end, end);
                        grow(el);
                      });
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                  onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData?.items ?? [])
                      .filter((it) => it.kind === "file")
                      .map((it) => it.getAsFile())
                      .filter((f): f is File => f !== null);
                    if (files.length > 0) {
                      e.preventDefault();
                      handleFiles(files);
                    }
                  }}
                />
                <div className="flex items-center gap-1 pb-1">
                  {busy ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="oc-tap h-8 w-8 shrink-0 rounded-full transition-all duration-200 border border-red-500/50 bg-red-500/15 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.25),inset_0_1px_0_0_rgba(255,255,255,0.12)] hover:bg-red-500/25 hover:border-red-500/70 hover:scale-105 active:scale-95"
                      onClick={stopTurn}
                      title={t("stop.action")}
                      aria-label={t("stop.action")}
                    >
                      <StopIcon size={14} />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="icon"
                      className={cn(
                        "oc-tap h-8 w-8 shrink-0 rounded-full transition-all duration-200",
                        canSend
                          ? "border border-white/20 bg-primary text-primary-foreground shadow-[0_0_12px_rgba(var(--primary),0.35),inset_0_1px_0_0_rgba(255,255,255,0.2)] hover:scale-105 hover:brightness-110 active:scale-95 cursor-pointer"
                          : "border border-white/10 bg-white/[0.05] text-muted-foreground/60 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.3)] cursor-not-allowed opacity-80",
                      )}
                      onClick={submit}
                      disabled={!canSend}
                      title={blockedReason ?? t("composer.otpravit")}
                      aria-label={t("composer.otpravit_soobschenie")}
                    >
                      <SendIcon size={15} />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </BorderBeam>
      </div>

      {/* Подсказка на всё окно, пока над страницей тащат файл. */}
      <ComposerDropOverlay visible={windowDrag} />
    </div>
  );
}
