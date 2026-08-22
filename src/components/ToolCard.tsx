import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Terminal,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { api } from "../api/client";
import { isRecord, strField } from "../api/eventGuards";
import {
  answerFromFeed,
  type Interruption,
  isBarQuestionPart,
  isInterruptedQuestionPart,
  isInterruptionBarEnabled,
  normalizeQuestion,
  questionFeedLine,
  replyTextAfterCall,
} from "../api/interruptions";
import type { ToolPart, ToolState } from "../api/types";
import { visibleMessageText } from "../lib/chatText";
import { log } from "../lib/log";
import {
  extractToolEdits,
  extractToolFilePath,
  extractWrittenContent,
} from "../lib/toolEdits";
import { useSmoothStreamingText } from "../lib/useSmoothText";
import { useStore } from "../store/useStore";
import { toolIcon } from "../utils/toolUtils";
import DiffView from "./DiffView";
import { t, tf } from "@/i18n";

function fmt(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getState(part: ToolPart): string {
  const s = part.state;
  if (typeof s === "string") return s === "pending" ? "running" : s;
  if (s && typeof s === "object") {
    const status = (s as ToolState).status ?? "running";
    return status === "pending" ? "running" : status;
  }
  if (part.output !== undefined && part.output !== null) {
    return "completed";
  }
  return "running";
}

function getTime(part: ToolPart): { start?: number; end?: number } {
  const s = part.state;
  if (s && typeof s === "object") return (s as ToolState).time || {};
  return {};
}

/** Live "1.8s" / "3s" duration label. Ticks while running, freezes once ended. */
function useDuration(
  time: { start?: number; end?: number },
  running: boolean,
): string | null {
  const [, setTick] = useState(0);
  // Если сервер не прислал time.end, фиксируем момент завершения сами:
  // иначе значение либо «плывёт» (Date.now() при каждом рендере),
  // либо зависает на устаревшем числе до следующего клика.
  const frozenEndRef = useRef<number | null>(null);
  if (running) {
    frozenEndRef.current = null;
  } else if (time.start && !time.end && frozenEndRef.current === null) {
    frozenEndRef.current = Date.now();
  }
  useEffect(() => {
    if (!running || !time.start) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [running, time.start]);
  if (!time.start) return null;
  const end = running
    ? Date.now()
    : (time.end ?? frozenEndRef.current ?? Date.now());
  const secs = Math.max(0, (end - time.start) / 1000);
  return secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`;
}

function getInput(part: ToolPart): unknown {
  const s = part.state;
  if (s && typeof s === "object") return (s as ToolState).input;
  return part.input;
}

function getOutput(part: ToolPart): string {
  const s = part.state;
  let out: unknown;
  if (s && typeof s === "object") out = (s as ToolState).output;
  else out = part.output;
  if (out == null && s && typeof s === "object") {
    // Стриминг: пока инструмент работает, промежуточный stdout
    // приходит в state.metadata.output — показываем его живьём,
    // не дожидаясь финального state.output.
    const meta = (s as ToolState).metadata;
    if (meta && typeof meta.output === "string") out = meta.output;
  }
  if (out == null) return "";
  if (typeof out === "string") return out;
  if (typeof out === "object") {
    const o = out as { type?: string; text?: string; error?: unknown };
    if (o.type === "error") {
      const errMsg =
        typeof o.error === "string"
          ? o.error
          : (strField(o.error, "message") ??
            JSON.stringify(o.error ?? "unknown"));
      return `Error: ${errMsg}`;
    }
    return fmt(out);
  }
  return String(out);
}

/** «/app/workspace/foo/bar.ts» → «bar.ts». */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/** Строка похожа на путь к файлу: есть разделители и нет пробелов. */
function looksLikePath(v: string): boolean {
  return /[\\/]/.test(v) && !/\s/.test(v);
}

function getSummary(part: ToolPart): string {
  const clip = (v: string) => (v.length > 72 ? `${v.slice(0, 69)}…` : v);
  const s = part.state;
  if (s && typeof s === "object") {
    const title = (s as ToolState).title;
    // В строке действия показываем только имя файла, без полного пути.
    if (title) return clip(looksLikePath(title) ? baseName(title) : title);
  }
  const input = getInput(part) as Record<string, unknown> | undefined;
  if (!input) return "";
  for (const k of ["filePath", "path"]) {
    const v = input[k];
    if (typeof v === "string" && v) return clip(baseName(v));
  }
  for (const k of ["command", "pattern", "query", "description"]) {
    const v = input[k];
    if (typeof v === "string" && v) return clip(v);
  }
  return "";
}

/**
 * Подпись действия в ленте.
 *
 * Интерфейс русский целиком — «Размышляет…», «Действия», «Готово», «Остановлено
 * пользователем», — а строки действий оставались английскими: «used Bash»,
 * «Wrote file», «Ran subtask». В одной ленте это читается как чужая вставка,
 * причём именно там, где пользователь разбирается, что агент сделал.
 *
 * Таблица одна на весь чат: группу вызовов подписывает она же (`ToolGroup`).
 * Две таблицы разъезжались бы, и один инструмент назывался бы двумя словами.
 */
export function friendlyToolLabel(tool?: string): string {
  const t = (tool || "").toLowerCase();
  if (t === "bash" || t === "shell" || t === "cmd") return t("tool_card.komanda");
  if (t === "read") return t("tool_card.chitaet_fayl");
  if (t === "write") return t("tool_card.pishet_fayl");
  if (t === "edit" || t === "applypatch" || t === "apply_patch")
    return t("tool_card.pravit_fayl");
  if (t === "patch") return t("tool_card.primenyaet_patch");
  if (t === "glob") return t("tool_card.ischet_fayly");
  if (t === "grep") return t("tool_card.ischet_po_tekstu");
  if (t === "ls" || t === "list") return t("tool_card.smotrit_papku");
  if (t === "webfetch" || t === "fetch") return t("tool_card.zagruzhaet_stranicu");
  if (t === "websearch" || t === "search") return t("tool_card.ischet_v_internete");
  if (t === "task") return t("tool_card.podzadacha");
  if (t === "todowrite" || t === "todo") return t("tool_card.obnovlyaet_plan");
  if (t === "question") return t("tool_card.vopros");
  if (t === "ensure_environment") return t("tool_card.gotovit_okruzhenie");
  if (t === "environment_status") return t("tool_card.proveryaet_okruzhenie");
  if (t === "repo_map") return t("tool_card.smotrit_strukturu_proekta");
  if (!tool) return t("tool_card.instrument");
  // Незнакомый инструмент называем его же именем, а не выдумываем перевод.
  return tf("tool_card.instrument_0", [tool]);
}

/* ---------- Question tool card ---------- */

interface QuestionItem {
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string; id?: string }>;
  allowCustomResponse?: boolean;
}

/** Один вариант ответа: строка или объект {label|text, description|desc, id}. */
function parseOption(o: unknown): {
  label: string;
  description: string;
  id?: string;
} {
  if (typeof o === "string") return { label: o, description: "" };
  const id = strField(o, "id");
  return {
    label: strField(o, "label") || strField(o, "text") || "",
    description: strField(o, "description") || strField(o, "desc") || "",
    ...(id !== undefined ? { id } : {}),
  };
}

/** Один вопрос из динамического пейлоада тула question — без any-кастов. */
function parseQuestionRecord(q: unknown): QuestionItem {
  const rec: Record<string, unknown> = isRecord(q) ? q : {};
  const allowCustomResponse =
    typeof rec.allowCustomResponse === "boolean"
      ? rec.allowCustomResponse
      : typeof rec.allowCustom === "boolean"
        ? rec.allowCustom
        : true;
  return {
    question: strField(rec, "question") || strField(rec, "text") || "",
    header: strField(rec, "header") || strField(rec, "title") || "",
    options: Array.isArray(rec.options) ? rec.options.map(parseOption) : [],
    allowCustomResponse,
  };
}

function parseQuestions(input: unknown): QuestionItem[] {
  if (!isRecord(input)) return [];
  if (Array.isArray(input.questions))
    return input.questions.map(parseQuestionRecord);
  if (input.question || input.options) return [parseQuestionRecord(input)];
  return [];
}

/**
 * Одна и та же пустая ссылка для чата без сообщений: селектор zustand
 * сравнивает результат по идентичности, и `?? []` возвращал бы новый массив на
 * каждый вызов — то есть «значение изменилось» при любом обновлении стора.
 */
const NO_MESSAGES: never[] = [];

/**
 * След вопроса в ленте после того, как на него ответили.
 *
 * Показывается вместо карточки: активный вопрос живёт в полосе, а история
 * переписки должна читаться целиком — иначе потом непонятно, почему агент
 * пошёл этим путём.
 *
 * Свёрнут по умолчанию, разворачивается нажатием. После исправления Q6/Q7
 * ответ больше не живёт отдельной user-репликой: native runtime возвращает его в
 * metadata завершённого question tool-call. Поэтому в строке можно показать
 * «вопрос — выбранный ответ» без дублирования пользовательского сообщения, а
 * в развёрнутом виде оставить полный набор предложенных вариантов.
 *
 * Что именно написать в свёрнутой строке, решает `questionFeedLine`, а не этот
 * компонент: протокольное решение не должно зависеть от вёрстки.
 */
function answersFromQuestionPart(part: ToolPart): string[][] | null {
  const state = isRecord(part.state) ? part.state : null;
  const metadata = state && isRecord(state.metadata) ? state.metadata : null;
  if (!metadata || !Array.isArray(metadata.answers)) return null;
  const answers = metadata.answers.map((answer) =>
    Array.isArray(answer)
      ? answer.filter((v): v is string => typeof v === "string")
      : [],
  );
  return answers.length > 0 ? answers : null;
}

function QuestionTrace({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const currentID = useStore((s) => s.currentID);
  const messages = useStore((s) =>
    currentID ? (s.messages[currentID] ?? NO_MESSAGES) : NO_MESSAGES,
  );

  const raw = getInput(part);
  const list =
    isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : [raw];
  // Без useMemo намеренно: разбор дешёвый, а список нужен только разметке —
  // за него не держится ни один обработчик, которому важна стабильная ссылка.
  const questions: Interruption[] = list.map((q) => normalizeQuestion(q, null));

  // Современный Question API сохраняет ответы в metadata tool-part после
  // успешного reply. Старый fallback с отдельным user-message оставляем только
  // для истории уже созданных сессий: новые ответы туда больше не попадают.
  const recorded = answersFromQuestionPart(part);
  const replyText = recorded
    ? ""
    : replyTextAfterCall(messages, part.callID ?? null, visibleMessageText);
  const answers = questions.map(
    (q, i) => recorded?.[i] ?? answerFromFeed(q, replyText),
  );
  const lines = questions.map((q, i) =>
    questionFeedLine(q, answers[i] ?? null),
  );
  const first = lines[0];
  if (!first) return null;

  const more = lines.length - 1;

  return (
    <div className="not-prose my-1.5 overflow-hidden rounded-xl border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-muted/40"
      >
        <span aria-hidden="true" className="shrink-0 text-muted-foreground">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          вопрос
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">
          {first.text}
        </span>
        {more > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            +{more}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/60 px-3 py-2.5">
          {questions.map((q, i) => {
            const chosen = answers[i];
            const line = lines[i];
            return (
              <div key={q.prompt} className="space-y-1.5">
                {q.prompt && (
                  <div className="text-[13px] text-foreground/90">
                    {q.prompt}
                  </div>
                )}
                {q.options.length > 0 && (
                  <ul className="space-y-1">
                    {q.options.map((o) => {
                      const picked = !!chosen?.includes(o.label);
                      return (
                        <li
                          key={o.value}
                          className={cn(
                            "flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12.5px]",
                            picked
                              ? "border-foreground/30 bg-foreground/[0.06] text-foreground"
                              : "border-border/50 text-muted-foreground",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className="mt-[1px] w-3 shrink-0 text-foreground"
                          >
                            {picked ? <Check size={12} /> : null}
                          </span>
                          <span className="min-w-0">
                            {o.label}
                            {o.description && (
                              <span className="block text-[11px] opacity-70">
                                {o.description}
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {/* Свободный ответ вариантом не был — показываем отдельно,
                    иначе выбор выглядел бы как «ни одного». */}
                {chosen &&
                  !chosen.some((c) => q.options.some((o) => o.label === c)) && (
                    <div className="text-[12.5px] text-foreground/85">
                      Ответ: {chosen.join(", ")}
                    </div>
                  )}
                {!chosen && line?.note && (
                  <div className="text-[11px] text-muted-foreground">
                    {line.note}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuestionCard({ part }: { part: ToolPart }) {
  const input = getInput(part);
  const state = getState(part);
  // Разбор даёт новые объекты на каждом рендере. Без useMemo список вопросов
  // менял бы ссылку постоянно и обнулял бы useCallback-обработчики ниже,
  // которые обязаны видеть актуальный вопрос при отправке ответа.
  const questions = useMemo(() => parseQuestions(input), [input]);
  const currentID = useStore((s) => s.currentID);
  const [customText, setCustomText] = useState<Record<number, string>>({});
  // Статус «отвечено» — по каждому вопросу отдельно (раньше был один
  // флаг на всю карточку, и ответ на один вопрос помечал «Ответ отправлен»
  // сразу у всех).
  const [answeredIdx, setAnsweredIdx] = useState<Record<number, boolean>>({});
  const [selectedIdx, setSelectedIdx] = useState<Record<number, number | null>>(
    {},
  );
  const [draftAnswers, setDraftAnswers] = useState<Record<number, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const isWaiting = state === "running";

  // Question tool блокируется на pending request. Ответ должен вернуться в
  // ЭТОТ ЖЕ request через /question/:id/reply; отдельное user-message здесь
  // запрещено, потому что оно создаёт новый turn и раньше требовало abort.
  const submitAnswers = useCallback(
    async (answers: string[][]) => {
      const sid = currentID;
      if (!sid) throw new Error(t("interruption_bar.net_aktivnoy_sessii"));
      const pending = await api.waitForPendingQuestion(sid);
      if (!pending) {
        throw new Error(
          t("tool_card.question_api_esche_ne_zaregistriroval_vopros"),
        );
      }
      await api.replyQuestion(sid, pending.id, answers);
    },
    [currentID],
  );

  const commitAnswer = useCallback(
    (qIdx: number, labels: string[], optIdx: number | null) => {
      if (answeredIdx[qIdx] || submitting) return;
      const clean = labels.map((v) => v.trim()).filter(Boolean);
      if (clean.length === 0) return;

      const nextDrafts = { ...draftAnswers, [qIdx]: clean };
      setDraftAnswers(nextDrafts);
      setSelectedIdx((prev) => ({ ...prev, [qIdx]: optIdx }));
      setAnsweredIdx((prev) => ({ ...prev, [qIdx]: true }));

      const complete = questions.every((_, idx) => nextDrafts[idx]?.length);
      if (!complete) return;

      setSubmitting(true);
      submitAnswers(questions.map((_, idx) => nextDrafts[idx] ?? []))
        .then(() => setSubmitted(true))
        .catch((err) => {
          log.error("[QuestionCard] submitAnswers failed:", err);
          toast(
            "error",
            err instanceof Error
              ? err.message
              : t("tool_card.ne_udalos_otpravit_otvet_na_vopros"),
          );
          // Ничего не abort'им и не создаём новую реплику. Возвращаем карточку
          // в редактируемое состояние, чтобы пользователь мог повторить.
          setAnsweredIdx({});
          setDraftAnswers({});
          setSelectedIdx({});
        })
        .finally(() => setSubmitting(false));
    },
    [answeredIdx, draftAnswers, questions, submitAnswers, submitting],
  );

  const handleOptionClick = useCallback(
    (qIdx: number, optIdx: number, label: string) => {
      commitAnswer(qIdx, [label], optIdx);
    },
    [commitAnswer],
  );

  const handleCustomSubmit = useCallback(
    (qIdx: number) => {
      const text = customText[qIdx]?.trim();
      if (!text) return;
      commitAnswer(qIdx, [text], null);
    },
    [commitAnswer, customText],
  );

  if (questions.length === 0) return <DefaultToolCard part={part} />;

  // Этап 2.1: пока полоса включена, вопрос показывается ТОЛЬКО в ней.
  // Две карточки на одно прерывание — два места, куда можно нажать, и ни
  // одного очевидного; к тому же карточка в ленте уходит прокруткой, ради
  // чего полоса и заводилась.
  //
  // Условие берётся из `isBarQuestionPart` — той же функции, по которой полоса
  // вопрос и находит. Своё условие здесь дало бы дыру: лента спрятала бы
  // вопрос, полоса его не узнала бы, и ход ждал бы ответа, которого не видно
  // нигде. Отвеченный вопрос предикат не проходит и остаётся в ленте историей.
  if (isInterruptionBarEnabled() && isBarQuestionPart(part)) return null;

  // Отвеченный вопрос при включённой полосе — свёрнутая строка. Активная
  // карточка живёт над композером, а после прямого Question reply выбранные
  // ответы читаются из metadata завершённого tool-call. Отдельной user-реплики
  // для выбора больше нет.
  if (isInterruptionBarEnabled()) {
    return <QuestionTrace part={part} />;
  }

  // По одному вопросу за раз: видны отвеченные и первый неотвеченный;
  // остальные появляются после ответа.
  const firstUnanswered = questions.findIndex((_, i) => !answeredIdx[i]);
  const allAnswered = firstUnanswered === -1;
  const hiddenCount = allAnswered ? 0 : questions.length - firstUnanswered - 1;

  return (
    <div
      className={cn(
        "not-prose my-1.5 overflow-hidden rounded-xl border",
        allAnswered || !isWaiting
          ? "border-foreground/25 bg-foreground/[0.04]"
          : "border-foreground/25 bg-foreground/[0.04]",
      )}
    >
      {questions.map((q, qIdx) => {
        const isAnswered = !!answeredIdx[qIdx];
        if (!isAnswered && qIdx !== firstUnanswered) return null;
        return (
          // id у вопросов нет, идентичность даёт их собственный текст: список
          // раскрывается по одному вопросу, и индекс переносил бы введённый
          // «свой ответ» на следующий вопрос.
          <div
            key={`${q.header ?? ""}|${q.question ?? ""}`}
            className={cn(
              "flex flex-col gap-2 p-3",
              qIdx > 0 && "border-t border-border",
            )}
          >
            {q.header && (
              <div className="text-[11px] font-bold uppercase tracking-wider text-foreground">
                {q.header}
              </div>
            )}
            {q.question && (
              <div className="text-[13.5px] font-medium leading-snug">
                {q.question}
              </div>
            )}
            {q.options && q.options.length > 0 && (
              <div className="flex flex-col gap-1">
                {q.options.map((opt, optIdx) => {
                  const selected = selectedIdx[qIdx] === optIdx;
                  const disabled = isAnswered;
                  return (
                    <button
                      key={opt.id ?? `${opt.label}|${opt.description}`}
                      type="button"
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border/80 bg-card/50 hover:border-primary/40 hover:bg-muted/40",
                        disabled && "cursor-default opacity-70",
                      )}
                      onClick={() =>
                        handleOptionClick(qIdx, optIdx, opt.label || "")
                      }
                      disabled={disabled}
                    >
                      <span className="text-[13px] font-semibold">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="text-[11px] text-muted-foreground">
                          {opt.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {q.allowCustomResponse !== false && isWaiting && !isAnswered && (
              <div className="mt-0.5 flex items-center gap-1.5">
                <Input
                  type="text"
                  className="h-8 text-[13px]"
                  placeholder={t("tool_card.ili_svoy_otvet")}
                  value={customText[qIdx] || ""}
                  onChange={(e) =>
                    setCustomText((prev) => ({
                      ...prev,
                      [qIdx]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCustomSubmit(qIdx);
                  }}
                />
                <Button
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-full"
                  onClick={() => handleCustomSubmit(qIdx)}
                  disabled={!customText[qIdx]?.trim()}
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            {isAnswered && (
              <div className="flex items-center gap-1 text-[11px] font-semibold text-foreground">
                <Check className="h-3 w-3" />
                {submitted
                  ? t("tool_card.otvet_otpravlen")
                  : submitting
                    ? t("tool_card.otpravlyaem_otvety")
                    : t("tool_card.otvet_vybran")}
              </div>
            )}
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <div className="border-t border-border px-3 py-2 font-mono text-[11px] text-muted-foreground/60">
          Следующий вопрос появится после ответа · осталось {hiddenCount}
        </div>
      )}
    </div>
  );
}

function CodeBlock({
  label,
  text,
  streaming,
}: {
  label: string;
  text: string;
  streaming?: boolean;
}) {
  // Плавный вывод: во время стрима текст догоняет цель постепенно
  // (вместо скачков пачками), а pre автопрокручивается к последним строкам.
  const shown = useSmoothStreamingText(text, !!streaming);
  const preRef = useRef<HTMLPreElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: shown в списке намеренно — автопрокрутка должна срабатывать на каждом новом чанке стрима, хотя само значение читается не в теле эффекта, а из DOM (scrollHeight).
  useEffect(() => {
    if (streaming && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [streaming, shown]);
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(text).then((ok) => {
      if (!ok) {
        toast("error", t("copy_button.ne_udalos_skopirovat_net_dostupa_k"));
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div
      className="rounded-lg border border-border overflow-hidden"
      style={{
        background: "color-mix(in srgb, var(--color-card) 100%, white 4%)",
      }}
    >
      <div
        className="flex items-center justify-between px-2.5 py-1 border-b border-border/70"
        style={{
          background: "color-mix(in srgb, var(--color-card) 100%, white 8%)",
        }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          className="p-1 rounded hover:bg-accent/60 text-muted-foreground/60 hover:text-foreground transition"
          title={t("copy_button.kopirovat")}
          aria-label={t("copy_button.kopirovat")}
        >
          {copied ? (
            <Check className="h-3 w-3 text-foreground" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </div>
      <pre
        ref={preRef}
        className="max-h-56 overflow-auto p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-all"
      >
        {shown}
        {streaming && <span className="streaming-cursor" />}
      </pre>
    </div>
  );
}

function DefaultToolCard({ part }: { part: ToolPart }) {
  const state = getState(part);
  const running = state === "running";
  // Сюда вопрос попадает в одном случае — нагрузка не разобралась, и вариантов
  // показать нечего. Красным он всё равно не рисуется: `error` у него значит
  // «ход оборван ради ответа», а не «инструмент сломался». Условие то же, что
  // в трёх других местах, и берётся из одной функции.
  const errored = state === "error" && !isInterruptedQuestionPart(part);
  const input = fmt(getInput(part));
  const output = getOutput(part);
  const summary = getSummary(part);
  // Записываемый файл показываем текстом, а не аргументами вызова: JSON с
  // экранированными переводами строк прочитать нельзя ни на ходу, ни после.
  // Строка приходит дельтами и растёт — поэтому пустая строка это «пишет,
  // но пока ничего», а `null` — «этот вызов файл не пишет».
  const written = extractWrittenContent(getInput(part));
  // Плейсхолдер оставляем только там, где показывать действительно нечего.
  const inputPending =
    running && written === null && (!input || input === "{}");
  const hasBody = Boolean(input || output || inputPending);
  const duration = useDuration(getTime(part), running);
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  const expanded = manuallyToggled ?? running;
  // Defensive: a streaming payload may contain an object {messageID, callID} in `tool` field
  // during streaming. After store normalization this should never reach UI,
  // but if anything slips through, fall back to undefined rather than
  // crashing with React error #31 (Objects are not valid as a React child).
  const toolName =
    typeof part.tool === "string" && part.tool ? part.tool : undefined;
  const label = friendlyToolLabel(toolName);
  const isBash = ["bash", "shell", "cmd"].includes(
    (toolName || "").toLowerCase(),
  );
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  // Правку файла показываем как diff, а не как JSON аргументов: из
  // «oldString/newString» в одну строку изменение не прочитать.
  const filePath = extractToolFilePath(getInput(part));
  const edits = extractToolEdits(getInput(part));

  return (
    <div className="not-prose my-1 oc-msg-in">
      {/* Ghost-строка заголовка tool: прозрачная, минимальная */}
      <button
        type="button"
        className={cn(
          "group/tool flex w-full items-center gap-2 px-2 py-1.5 text-left rounded-lg transition",
          hasBody && "hover:bg-accent/30 cursor-pointer",
          !hasBody && "cursor-default",
        )}
        // Один клик всегда переключает относительно видимого состояния.
        // Старая логика (null → false) требовала двойного клика после
        // завершения действия: первый клик лишь фиксировал «свернуто».
        onClick={hasBody ? () => setManuallyToggled(!expanded) : undefined}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
          {toolIcon(toolName) || <Terminal className="h-3 w-3" />}
        </span>
        {/* Название */}
        <span className="text-[13px] font-medium text-foreground/85">
          {label}
        </span>
        {/* Статус: ✓ или ● или ✕ */}
        {running && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse" />
        )}
        {!running && !errored && (
          <Check
            className="h-3.5 w-3.5 shrink-0 text-foreground"
            strokeWidth={2.5}
          />
        )}
        {errored && (
          <span className="text-[11px] font-medium text-red-400">error</span>
        )}
        {/* Duration */}
        {duration && (
          <span className="text-[11.5px] text-muted-foreground/70">
            {duration}
          </span>
        )}
        {/* Summary inline (обрезается) */}
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70">
            {summary}
          </span>
        )}
        {!summary && <span className="flex-1" />}
        {/* Chevron */}
        {hasBody && (
          <span className="text-muted-foreground/50 shrink-0">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        )}
      </button>

      {/* Раскрытые секции в стиле Arena: COMMAND / STDOUT etc */}
      {hasBody && expanded && (
        <div className="oc-card-open mt-1.5 ml-6 space-y-1.5">
          {filePath && (
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={() => requestOpenFile(filePath)}
              title={t("tool_card.otkryt_fayl_v_paneli_faylov")}
            >
              <ArrowRight className="h-3 w-3" />
              {filePath}
            </button>
          )}
          {inputPending ? (
            <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-muted-foreground/70">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse" />
              Генерирует содержимое…
            </div>
          ) : written !== null ? (
            // Содержимое файла. Пока идёт запись, текст дописывается на
            // глазах — это тот же поток, что у вывода команды, просто
            // раньше он показывался JSON'ом.
            <CodeBlock
              label={filePath ? t("tool_card.soderzhimoe") : t("tool_card.fayl")}
              text={written}
              streaming={running}
            />
          ) : edits.length > 0 ? (
            // Правка файла — показываем именно изменение, а не аргументы вызова.
            // Ключ — по самой правке: у элементов multiedit нет id, а индекс
            // сбрасывал бы прокрутку внутри diff'а при дорисовке правок.
            edits.map((edit) => (
              <DiffView
                key={`${filePath ?? "edit"}:${edit.oldText.slice(0, 64)}→${edit.newText.slice(0, 64)}`}
                oldText={edit.oldText}
                newText={edit.newText}
                emptyLabel={t("tool_card.instrument_ne_izmenil_soderzhimoe")}
              />
            ))
          ) : (
            input &&
            input !== "{}" && (
              <CodeBlock
                label={isBash ? "COMMAND" : "INPUT"}
                text={input}
                streaming={running}
              />
            )
          )}
          {output && (
            <CodeBlock
              label={isBash ? "STDOUT" : "OUTPUT"}
              text={output}
              streaming={running}
            />
          )}
        </div>
      )}
    </div>
  );
}

const ToolCard = ({ part }: { part: ToolPart }) => {
  const toolName = typeof part.tool === "string" ? part.tool : "";
  if (toolName.toLowerCase() === "question")
    return <QuestionCard part={part} />;
  return <DefaultToolCard part={part} />;
};

export default memo(ToolCard);
