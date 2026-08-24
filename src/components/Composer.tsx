import {
  FileArchive as FileArchiveIcon,
  FileText as FileTextIcon,
  Image as ImageIcon,
} from "lucide-react";
import { BorderBeam } from "border-beam";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../api/client";
import { statusText } from "../api/eventGuards";
import type { ProcessedFile } from "../api/files";
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
import type { FileNode } from "../api/types";
import { sessionActionPrep } from "../lib/ids";
import { useStore } from "../store/useStore";
import { CloseIcon, PaperclipIcon, SendIcon, StopIcon } from "./icons";
import { t, tf } from "@/i18n";

// Черновики по сессиям: текст композера не теряется при переключении чатов.
// Живёт в памяти вкладки — намеренно не персистится.
const sessionDrafts = new Map<string, string>();

// То же для вложений. Раньше массив вложений был один на всё приложение:
// прикрепив файл в чате A и переключившись в B, вы отправляли в B сообщение
// со строкой «📎 name → uploads/name», но сам файл лежал в workspace чата A —
// у агента B такого файла нет, и задача падала на ровном месте.
const sessionAttachments = new Map<string, ProcessedFile[]>();

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

// Slash-команды: быстрые шаблоны запросов, дропдаун открывается по «/».
const SLASH_COMMANDS: Array<{ cmd: string; hint: string; insert: string }> = [
  {
    cmd: t("composer.rezyume"),
    hint: t("composer.kratkoe_rezyume_dialoga"),
    insert:
      t("composer.sdelay_kratkoe_rezyume_nashego_dialoga_klyuc"),
  },
  {
    cmd: t("composer.testy"),
    hint: t("composer.zapustit_testy"),
    insert:
      t("composer.zapusti_testy_i_pokazhi_rezultat_esli"),
  },
  {
    cmd: t("composer.fiks"),
    hint: t("composer.pochinit_poslednyuyu_oshibku"),
    insert:
      t("composer.naydi_prichinu_posledney_oshibki_i_predlozhi"),
  },
  {
    cmd: t("composer.revyu"),
    hint: t("composer.kod_revyu_izmeneniy"),
    insert:
      t("composer.sdelay_kod_revyu_poslednih_izmeneniy_oshibki"),
  },
  {
    cmd: t("composer.kommit"),
    hint: t("composer.soobschenie_kommita"),
    insert:
      t("composer.sformuliruy_soobschenie_kommita_dlya_tekusch"),
  },
];

/** Иконка по типу вложения — тот же набор, что в чипах сообщений. */
function attachmentIcon(kind: string) {
  if (kind === "image") return <ImageIcon size={15} />;
  if (kind === "zip") return <FileArchiveIcon size={15} />;
  if (kind === "pdf" || kind === "text") return <FileTextIcon size={15} />;
  return <PaperclipIcon size={15} />;
}

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
  const [caret, setCaret] = useState(0);
  const [slashIdx, setSlashIdx] = useState(0);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<FileNode[] | null>(null);

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

  // Черновик на сессию: при переключении чата сохраняем набранный текст
  // и вложения, восстанавливаем сохранённые для выбранной сессии.
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev !== null && prev !== currentID) {
      if (textRef.current) sessionDrafts.set(prev, textRef.current);
      else sessionDrafts.delete(prev);
      setText(sessionDrafts.get(currentID ?? "") ?? "");

      // Вложения принадлежат workspace своей сессии — переносить их
      // в другой чат нельзя (файла там физически нет).
      if (attachmentsRef.current.length > 0) {
        sessionAttachments.set(prev, attachmentsRef.current);
      } else {
        sessionAttachments.delete(prev);
      }
      clearAttachments();
      const restored = currentID
        ? sessionAttachments.get(currentID)
        : undefined;
      if (restored?.length) addAttachments(restored);
    }
    prevSessionRef.current = currentID;
  }, [currentID, clearAttachments, addAttachments]);

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
      setUploadError(blockedReason);
      setTimeout(() => setUploadError(null), 6000);
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
        if (currentID) sessionDrafts.delete(currentID);
        if (currentID) sessionAttachments.delete(currentID);
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
      sessionDrafts.delete(currentID);
      sessionAttachments.delete(currentID);
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
        tf("composer.slishkom_bolshoy_fayl_maksimum_0_1", [formatSize(MAX_UPLOAD_BYTES), names.join(", ")]),
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
            const saved = sessionAttachments.get(sid) ?? [];
            sessionAttachments.set(sid, [
              ...saved.filter((item) => item.name !== processed.name),
              processed,
            ]);
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

  // Приём файла в любой точке окна, а не только над полем ввода.
  //
  // Раньше drop мимо композера обрабатывал сам браузер: он открывал файл
  // как страницу, и чат просто исчезал вместе с несохранённым вводом.
  // Попадание в узкую полосу композера с первого раза — неудобно, поэтому
  // теперь зона приёма — всё окно, с явной подсказкой поверх.
  const [windowDrag, setWindowDrag] = useState(false);
  const dragDepth = useRef(0);
  const handleFilesRef = useRef(handleFiles);
  handleFilesRef.current = handleFiles;

  useEffect(() => {
    // dragenter/dragleave приходят и от вложенных элементов, поэтому
    // считаем глубину, иначе подсказка мигает при движении курсора.
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setWindowDrag(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // без этого drop не сработает
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setWindowDrag(false);
    };
    const onDropWindow = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // иначе браузер откроет файл вместо чата
      dragDepth.current = 0;
      setWindowDrag(false);
      setDragOver(false);
      handleFilesRef.current(e.dataTransfer?.files ?? null);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDropWindow);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDropWindow);
    };
  }, []);

  const canSend =
    (text.trim().length > 0 || attachments.length > 0) && !blockedReason;

  // --- Slash-команды и @-упоминания файлов workspace ---
  const slashQuery = /^\/[^\s\n]*$/.test(text) ? text.toLowerCase() : null;
  const slashMatches = slashQuery
    ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(slashQuery))
    : [];

  const mentionMatch = /(^|\s)@([\w./-]*)$/.exec(text.slice(0, caret));
  const mentionQuery = mentionMatch
    ? (mentionMatch[2] ?? "").toLowerCase()
    : null;

  const mentionMatches =
    mentionQuery !== null && mentionFiles
      ? mentionFiles
          .filter((f) => f.path.toLowerCase().includes(mentionQuery))
          .slice(0, 8)
      : [];

  // Дерево файлов workspace грузим лениво при первом «@» и кэшируем.
  useEffect(() => {
    if (mentionQuery === null || mentionFiles !== null || !currentID) return;
    let cancelled = false;
    api
      .listTree(currentID)
      .then((nodes) => {
        if (cancelled) return;
        const files = nodes.filter(
          (n) => n.type !== "directory" && !n.isDirectory,
        );
        setMentionFiles(files.slice(0, 2000));
      })
      .catch(() => {
        if (!cancelled) setMentionFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery, mentionFiles, currentID]);

  // Кэш дерева файлов принадлежит сессии. Сброс на рендере, а не в useEffect:
  // тело эффекта не читало currentID (для линтера зависимость лишняя), да и
  // подсказки @ один кадр показывали файлы предыдущего чата.
  const mentionSessionRef = useRef(currentID);
  if (mentionSessionRef.current !== currentID) {
    mentionSessionRef.current = currentID;
    setMentionFiles(null);
  }

  const applySlash = (c: (typeof SLASH_COMMANDS)[number]) => {
    setText(c.insert);
    setSlashIdx(0);
    textareaRef.current?.focus();
  };

  const applyMention = (f: FileNode) => {
    if (!mentionMatch) return;
    const start = caret - (mentionMatch[2] ?? "").length;
    const next = `${text.slice(0, start)}${f.path} ${text.slice(caret)}`;
    setText(next);
    setMentionIdx(0);
    setCaret(start + f.path.length + 1);
    textareaRef.current?.focus();
  };

  return (
    <div className="w-full max-w-3xl shrink-0 mx-auto px-3 md:px-6 pb-6 pointer-events-none">
      {/* Именованная <section>, а не безымянный div: это зона приёма файлов
          (drag&drop), и у интерактивного контейнера должна быть роль. Клавиатурный
          путь для тех же файлов — кнопка «Прикрепить файл» и вставка из буфера. */}
      <section
        aria-label={t("composer.pole_vvoda_soobscheniya")}
        className={cn(
          "pointer-events-auto relative w-full transition-all duration-[200ms]",
          // Крупный радиус и мягкая тень вместо жёсткой рамки — так поле
          // ввода выглядит в обоих референсах. Тень границу ЗАМЕНЯЕТ, а не
          // дополняет: рамка осталась, но приглушена до половины, иначе
          // получались бы два контура один в другом.
          "bg-card/95 backdrop-blur-md rounded-3xl px-3 py-2.5 border border-border/60 shadow-sm",
          // Фокус подсвечивает ОБЁРТКУ, а не саму textarea. У textarea стили
          // фокуса сняты явно (`focus-visible:ring-0` ниже) и это правильно:
          // кольцо внутри рамки композера читалось бы как рамка в рамке.
          // Но без подсветки контейнера главное поле приложения оставалось
          // единственным местом, где клавиатурный пользователь не видит, где
          // он, — при том что кнопки, поля и переключатели кольцо имеют.
          "focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25",
          dragOver && "ring-2 ring-primary bg-primary/5",
        )}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {(slashMatches.length > 0 || mentionMatches.length > 0) && (
          <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            {slashMatches.map((c, i) => (
              <button
                key={c.cmd}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
                  i === slashIdx % slashMatches.length
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground",
                )}
                onClick={() => applySlash(c)}
              >
                <span className="font-mono font-semibold">{c.cmd}</span>
                <span className="truncate opacity-70">{c.hint}</span>
              </button>
            ))}
            {slashMatches.length === 0 &&
              mentionMatches.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
                    i === mentionIdx % mentionMatches.length
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground",
                  )}
                  onClick={() => applyMention(f)}
                >
                  <span aria-hidden="true">📄</span>
                  <span className="truncate font-mono">{f.path}</span>
                </button>
              ))}
          </div>
        )}
        <div className="flex flex-col gap-1">
          {/* P2-fix: очередь сообщений, ожидающих окончания генерации */}
          {queued.length > 0 && (
            <div className="flex flex-wrap gap-2 px-2 pb-1">
              {queued.map((q) => (
                <div
                  key={q.actionId}
                  className="flex items-center gap-2 rounded-full bg-muted border border-border px-2 py-1 text-xs text-muted-foreground"
                  title={q.text}
                >
                  <span className="opacity-60">⏳</span>
                  <span className="truncate max-w-[160px]">
                    {q.text ||
                      q.attachments
                        ?.map((attachment) => attachment.name)
                        .join(", ") ||
                      t("composer.vlozhenie")}
                  </span>
                  <button
                    type="button"
                    className="hover:text-destructive"
                    aria-label={t("composer.ubrat_soobschenie_iz_ocheredi")}
                    onClick={() => {
                      const plan = removalPlan(q, currentID);
                      setQueued((prev) =>
                        prev.filter((m) => m.actionId !== plan.actionId),
                      );
                      if (plan.kind === "server") {
                        api
                          .dequeueAction(plan.sessionId, plan.actionId)
                          .catch(() => {});
                      }
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Вложения и незавершённые загрузки — одним рядом карточек.
              Раньше это были два разных ряда безымянных «пилюль»: загрузка
              показывалась в одном месте, а готовый файл появлялся в другом,
              без иконки, размера и превью. */}
          {(attachments.length > 0 ||
            Object.keys(uploadProgress).length > 0) && (
            <div className="flex flex-wrap gap-2 px-2 pb-2">
              {attachments.map((att) => (
                <div
                  key={att.name}
                  className="group/chip flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pl-1.5 pr-1 text-xs"
                >
                  {att.kind === "image" && att.workspacePath && currentID ? (
                    <img
                      src={`/api/sandbox-proxy/${encodeURIComponent(currentID)}/~/${att.workspacePath
                        .split("/")
                        .map(encodeURIComponent)
                        .join("/")}`}
                      alt={att.name}
                      className="h-8 w-8 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background/70 text-muted-foreground">
                      {attachmentIcon(att.kind)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">
                      {att.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatSize(att.size)}
                      {typeof att.entryCount === "number" &&
                        tf("composer.0_faylov", [att.entryCount])}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-muted-foreground/60 transition hover:bg-background/60 hover:text-destructive"
                    aria-label={tf("composer.ubrat_fayl_0", [att.name])}
                    onClick={() => removeAttachment(att.name)}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              ))}

              {Object.entries(uploadProgress).map(([name, pct]) => (
                <div
                  key={`up:${name}`}
                  className="flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pl-1.5 pr-2.5 text-xs"
                >
                  <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                    {/* Кольцевой индикатор: conic-gradient по проценту. */}
                    <span
                      className="absolute inset-0 rounded-full"
                      style={{
                        background: `conic-gradient(var(--color-primary) ${pct * 3.6}deg, color-mix(in srgb, var(--color-border) 100%, transparent) 0deg)`,
                      }}
                    />
                    <span className="absolute inset-[3px] rounded-full bg-card" />
                    <span className="relative text-[9px] font-semibold tabular-nums text-foreground/80">
                      {pct}
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">
                      {name}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Загрузка…
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Input area */}
          <div className="flex items-end gap-2 px-2 py-1 mt-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
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
                if (slashMatches.length > 0) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const d = e.key === "ArrowDown" ? 1 : -1;
                    const len = slashMatches.length;
                    setSlashIdx((i) => (i + d + len) % len);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const c = slashMatches[slashIdx % slashMatches.length];
                    if (c) applySlash(c);
                    return;
                  }
                }
                if (mentionMatches.length > 0) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const d = e.key === "ArrowDown" ? 1 : -1;
                    const len = mentionMatches.length;
                    setMentionIdx((i) => (i + d + len) % len);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const f =
                      mentionMatches[mentionIdx % mentionMatches.length];
                    if (f) applyMention(f);
                    return;
                  }
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
                  // Не `destructive`: остановить собственного агента — обычное
                  // управление, а не разрушительное действие и не ошибка.
                  // Красный сигналил об опасности там, где её нет, и вдобавок
                  // брал цвет мимо темы (у варианта захардкожен `bg-red-600`).
                  variant="secondary"
                  size="icon"
                  className="oc-tap h-7 w-7 shrink-0 rounded-full"
                  onClick={() => {
                    // «Стоп» означает «стоп», включая то, что уйдёт само.
                    // Раньше очередь переживала остановку и отправляла
                    // следующую запись сразу, как только сессия освобождалась:
                    // агент останавливался и тут же начинал новый ход —
                    // со стороны неотличимо от «остановиться не может».
                    //
                    // Серверные записи снимаются и на сервере: оставить их там
                    // значило бы вернуть очередь при следующем обновлении.
                    for (const q of queued) {
                      const plan = removalPlan(q, currentID);
                      if (plan.kind === "server") {
                        api
                          .dequeueAction(plan.sessionId, plan.actionId)
                          .catch(() => {});
                      }
                    }
                    setQueued([]);
                    abort();
                  }}
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
                    "oc-tap h-7 w-7 shrink-0 rounded-full transition-all",
                    canSend
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                  onClick={submit}
                  disabled={!canSend}
                  title={blockedReason ?? t("composer.otpravit")}
                  aria-label={t("composer.otpravit_soobschenie")}
                >
                  <SendIcon size={14} />
                </Button>
              )}
            </div>
          </div>
        </div>
        {uploadError && (
          <div className="absolute -top-8 left-0 right-0 text-center text-xs text-red-400 animate-in fade-in slide-in-from-bottom-1">
            {uploadError}
          </div>
        )}
        <BorderBeam
          className="pointer-events-none absolute inset-0 rounded-3xl"
          size="md"
          colorVariant="colorful"
          active
        />
      </section>

      {/* Подсказка на всё окно, пока над страницей тащат файл. */}
      {windowDrag && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-card/90 px-10 py-8 shadow-xl">
            <span className="text-primary">
              <PaperclipIcon size={28} />
            </span>
            <div className="text-center">
              <div className="text-sm font-semibold text-foreground">
                Отпустите, чтобы прикрепить
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Файлы попадут в workspace этого чата · до{" "}
                {formatSize(MAX_UPLOAD_BYTES)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
