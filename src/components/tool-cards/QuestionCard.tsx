import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api } from "../../api/client";
import { isRecord, strField } from "../../api/eventGuards";
import {
  answerFromFeed,
  type Interruption,
  normalizeQuestion,
  questionFeedLine,
  replyTextAfterCall,
} from "../../api/interruptions";
import type { ToolPart } from "../../api/types";
import { visibleMessageText } from "../../lib/chatText";
import { QuestionTool, type QuestionConfig } from "../QuestionTool";
import { useStore } from "../../store/useStore";
import { log } from "../../lib/log";
import { toast } from "../../lib/toast";
import { cn } from "@/lib/utils";
import { getInput, getState } from "./toolCardUtils";
import { t } from "@/i18n";

const NO_MESSAGES: never[] = [];

export interface QuestionItem {
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string; id?: string }>;
  allowCustomResponse?: boolean;
}

export function parseOption(o: unknown): {
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

export function parseQuestionRecord(q: unknown): QuestionItem {
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

export function parseQuestions(input: unknown): QuestionItem[] {
  if (!isRecord(input)) return [];
  if (Array.isArray(input.questions))
    return input.questions.map(parseQuestionRecord);
  if (input.question || input.options) return [parseQuestionRecord(input)];
  return [];
}

export function answersFromQuestionPart(part: ToolPart): string[][] | null {
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

export function QuestionTrace({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const currentID = useStore((s) => s.currentID);
  const messages = useStore((s) =>
    currentID ? (s.messages[currentID] ?? NO_MESSAGES) : NO_MESSAGES,
  );

  const raw = getInput(part);
  const list =
    isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : [raw];
  const questions: Interruption[] = list.map((q) => normalizeQuestion(q, null));

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
          {t("tool_card.vopros")}
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
                {chosen &&
                  !chosen.some((c) => q.options.some((o) => o.label === c)) && (
                    <div className="text-[12.5px] text-foreground/85">
                      {chosen.join(", ")}
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

export function QuestionCard({ part }: { part: ToolPart }) {
  const input = getInput(part);
  const state = getState(part);
  const questions = useMemo(() => parseQuestions(input), [input]);
  const currentID = useStore((s) => s.currentID);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const isWaiting = state === "running";

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
      setSubmitting(true);
      try {
        await api.replyQuestion(sid, pending.id, answers);
        setSubmitted(true);
      } finally {
        setSubmitting(false);
      }
    },
    [currentID],
  );

  const questionConfigs: QuestionConfig[] = useMemo(
    () =>
      questions.map((q, idx) => ({
        id: `q-${idx}`,
        title: q.question || q.header || `Question ${idx + 1}`,
        ...(q.header ? { header: q.header } : {}),
        allowCustom: q.allowCustomResponse !== false,
        options: (q.options ?? []).map((opt, oIdx) => ({
          id: opt.id ?? opt.label ?? `opt-${oIdx}`,
          label: opt.label ?? opt.id ?? `Option ${oIdx + 1}`,
          ...(opt.description ? { description: opt.description } : {}),
        })),
      })),
    [questions],
  );

  if (questionConfigs.length === 0) return null;

  return (
    <div className="not-prose my-2 w-full max-w-lg">
      <QuestionTool
        questions={questionConfigs}
        busy={submitting || !isWaiting || submitted}
        onSubmitAnswer={async (answers) => {
          const allValues = answers.map((ans) => {
            if (ans.kind === "skip") return ["skip"];
            if (ans.text) return [ans.text];
            return ans.selectedLabels && ans.selectedLabels.length > 0
              ? ans.selectedLabels
              : (ans.selectedIds ?? []);
          });
          setSubmitting(true);
          try {
            await submitAnswers(allValues);
            setSubmitted(true);
          } catch (err) {
            log.error("[QuestionCard] submitAnswers failed:", err);
            toast("error", err instanceof Error ? err.message : String(err));
          } finally {
            setSubmitting(false);
          }
        }}
      />
    </div>
  );
}
