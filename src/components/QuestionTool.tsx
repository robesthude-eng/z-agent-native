import {
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  CircleHelp as CircleHelpIcon,
  Send as SendIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export type QuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type QuestionConfig = {
  id?: string;
  kind?: "single" | "multi" | "text";
  title: string;
  header?: string;
  description?: string;
  options?: QuestionOption[];
  allowCustom?: boolean;
  customPlaceholder?: string;
  minSelections?: number;
  maxSelections?: number;
  placeholder?: string;
};

export type QuestionAnswer = {
  kind: "single" | "multi" | "text" | "skip";
  selectedIds?: string[];
  selectedLabels?: string[];
  text?: string;
};

const CUSTOM_ID = "__custom__";

function optionBadge(idx: number) {
  return String.fromCharCode(65 + idx);
}

export type QuestionToolProps = {
  questions: QuestionConfig[];
  questionIndex?: number;
  totalQuestions?: number;
  onPreviousQuestion?: () => void;
  onNextQuestion?: () => void;
  initialAnswers?: Record<number, QuestionAnswer>;
  submitLabel?: string;
  nextLabel?: string;
  skipLabel?: string;
  allowSkip?: boolean;
  busy?: boolean;
  onSubmitAnswer?: (answers: QuestionAnswer[]) => void;
  onSubmitSingle?: (questionIdx: number, answer: QuestionAnswer) => void;
  onSkip?: () => void;
  className?: string;
};

export function QuestionTool({
  questions,
  questionIndex: controlledIndex,
  totalQuestions: controlledTotal,
  onPreviousQuestion,
  onNextQuestion,
  initialAnswers,
  submitLabel,
  nextLabel,
  skipLabel,
  allowSkip = true,
  busy = false,
  onSubmitAnswer,
  onSubmitSingle,
  onSkip,
  className,
}: QuestionToolProps) {
  const total = controlledTotal ?? questions.length;
  const [internalIndex, setInternalIndex] = useState(1);
  const isControlled = typeof controlledIndex === "number";
  const currentIndex = isControlled
    ? controlledIndex
    : questions.length > 0
      ? internalIndex
      : 1;
  const clampedIndex = Math.max(1, Math.min(currentIndex, Math.max(1, total)));

  const activeQuestion = questions[clampedIndex - 1];

  const [localAnswers, setLocalAnswers] = useState<
    Record<number, QuestionAnswer>
  >(initialAnswers ?? {});

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customText, setCustomText] = useState("");
  const [freeText, setFreeText] = useState("");

  const customEnabled = activeQuestion?.allowCustom ?? true;
  const kind = activeQuestion?.kind ?? "single";

  // Синхронизация состояния при смене активного вопроса
  useEffect(() => {
    const saved = localAnswers[clampedIndex];
    if (!saved || saved.kind === "skip") {
      setSelectedIds([]);
      setCustomText("");
      setFreeText("");
      return;
    }

    if (saved.kind === "text") {
      setSelectedIds([]);
      setCustomText("");
      setFreeText(saved.text ?? "");
      return;
    }

    const nextSelected = new Set(saved.selectedIds ?? []);
    const nextCustom = saved.text ?? "";
    if (customEnabled && nextCustom.trim().length > 0) {
      nextSelected.add(CUSTOM_ID);
    }
    setSelectedIds(Array.from(nextSelected));
    setCustomText(nextCustom);
    setFreeText("");
  }, [clampedIndex, customEnabled, localAnswers]);

  const canGoPrev = clampedIndex > 1;
  const canGoNext = clampedIndex < total;
  const isLastQuestion = clampedIndex >= total;

  const resolvedSubmitLabel = submitLabel ?? t("composer.otpravit");
  const resolvedNextLabel = nextLabel ?? "Next";
  const resolvedSkipLabel = skipLabel ?? "Skip";
  const primaryLabel = isLastQuestion
    ? resolvedSubmitLabel
    : resolvedNextLabel;

  const canSubmit = useMemo(() => {
    if (!activeQuestion) return false;
    if (kind === "text") return freeText.trim().length > 0;

    const selectedNonCustom = selectedIds.filter((id) => id !== CUSTOM_ID).length;
    const hasCustomText = customText.trim().length > 0;
    const count = selectedNonCustom + (hasCustomText ? 1 : 0);

    if (kind === "single") {
      return count === 1;
    }

    const min = activeQuestion.minSelections ?? 1;
    const max = activeQuestion.maxSelections;
    if (count < min) return false;
    if (typeof max === "number" && count > max) return false;
    return count > 0;
  }, [activeQuestion, customText, freeText, kind, selectedIds]);

  const handleSelectOption = useCallback(
    (optId: string) => {
      if (busy) return;
      if (kind === "single") {
        setSelectedIds([optId]);
        if (customEnabled) setCustomText("");
      } else {
        setSelectedIds((prev) =>
          prev.includes(optId)
            ? prev.filter((x) => x !== optId)
            : [...prev, optId],
        );
      }
    },
    [busy, customEnabled, kind],
  );

  const handleCustomChange = useCallback(
    (text: string) => {
      setCustomText(text);
      if (kind === "single") {
        setSelectedIds(text.trim().length > 0 ? [CUSTOM_ID] : []);
      } else {
        setSelectedIds((prev) => {
          const has = prev.includes(CUSTOM_ID);
          if (text.trim().length > 0 && !has) return [...prev, CUSTOM_ID];
          if (text.trim().length === 0 && has)
            return prev.filter((x) => x !== CUSTOM_ID);
          return prev;
        });
      }
    },
    [kind],
  );

  const buildCurrentAnswer = useCallback((): QuestionAnswer => {
    if (kind === "text") {
      return { kind: "text", text: freeText.trim() };
    }

    const nonCustomIds = selectedIds.filter((id) => id !== CUSTOM_ID);
    const nonCustomLabels =
      activeQuestion?.options
        ?.filter((o) => nonCustomIds.includes(o.id))
        .map((o) => o.label) ?? nonCustomIds;

    const trimmedCustom = customText.trim() || undefined;

    return {
      kind,
      selectedIds: nonCustomIds,
      selectedLabels: nonCustomLabels,
      text: trimmedCustom,
    };
  }, [activeQuestion?.options, customText, freeText, kind, selectedIds]);

  const handleNextOrSubmit = useCallback(() => {
    if (!canSubmit || !activeQuestion || busy) return;

    const currentAnswer = buildCurrentAnswer();
    const nextLocal = { ...localAnswers, [clampedIndex]: currentAnswer };
    setLocalAnswers(nextLocal);
    onSubmitSingle?.(clampedIndex - 1, currentAnswer);

    if (clampedIndex < total) {
      if (onNextQuestion) onNextQuestion();
      else setInternalIndex((prev) => Math.min(total, prev + 1));
    } else {
      // Все вопросы пройдены — отправляем итоговый массив
      const allAnswers: QuestionAnswer[] = Array.from(
        { length: total },
        (_, idx) => nextLocal[idx + 1] ?? { kind: "skip" },
      );
      onSubmitAnswer?.(allAnswers);
    }
  }, [
    activeQuestion,
    buildCurrentAnswer,
    busy,
    canSubmit,
    clampedIndex,
    localAnswers,
    onNextQuestion,
    onSubmitAnswer,
    onSubmitSingle,
    total,
  ]);

  const handleSkip = useCallback(() => {
    if (busy) return;
    onSkip?.();
    const skipAnswer: QuestionAnswer = { kind: "skip" };
    const nextLocal = { ...localAnswers, [clampedIndex]: skipAnswer };
    setLocalAnswers(nextLocal);
    onSubmitSingle?.(clampedIndex - 1, skipAnswer);

    if (clampedIndex < total) {
      if (onNextQuestion) onNextQuestion();
      else setInternalIndex((prev) => Math.min(total, prev + 1));
    } else {
      const allAnswers: QuestionAnswer[] = Array.from(
        { length: total },
        (_, idx) => nextLocal[idx + 1] ?? { kind: "skip" },
      );
      onSubmitAnswer?.(allAnswers);
    }
  }, [
    busy,
    clampedIndex,
    localAnswers,
    onNextQuestion,
    onSkip,
    onSubmitAnswer,
    onSubmitSingle,
    total,
  ]);

  const goPrev = useCallback(() => {
    if (!canGoPrev || busy) return;
    if (onPreviousQuestion) onPreviousQuestion();
    else setInternalIndex((prev) => Math.max(1, prev - 1));
  }, [busy, canGoPrev, onPreviousQuestion]);

  const goNext = useCallback(() => {
    if (!canGoNext || busy) return;
    if (onNextQuestion) onNextQuestion();
    else setInternalIndex((prev) => Math.min(total, prev + 1));
  }, [busy, canGoNext, onNextQuestion]);

  if (!activeQuestion) return null;

  return (
    <div
      className={cn(
        "w-full rounded-2xl border border-white/[0.12] bg-[#141416]/95 backdrop-blur-md shadow-2xl overflow-hidden font-sans text-foreground transition-all",
        className,
      )}
    >
      {/* Шапка карточки */}
      <div className="h-9 border-b border-white/[0.08] px-3.5 flex items-center justify-between text-xs text-muted-foreground bg-white/[0.02]">
        <div className="inline-flex items-center gap-1.5 font-medium tracking-wide">
          <CircleHelpIcon className="w-3.5 h-3.5 text-primary/90" />
          <span>{activeQuestion.header || "Question"}</span>
        </div>

        {total > 1 && (
          <div className="inline-flex items-center gap-1 text-xs">
            <button
              type="button"
              onClick={goPrev}
              disabled={!canGoPrev || busy}
              className="size-5 inline-flex items-center justify-center rounded hover:bg-white/[0.08] disabled:opacity-30 transition"
              aria-label="Previous question"
            >
              <ChevronUpIcon className="w-3.5 h-3.5" />
            </button>
            <span className="tabular-nums px-1 font-mono text-[11.5px]">
              {clampedIndex} of {total}
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={!canGoNext || busy}
              className="size-5 inline-flex items-center justify-center rounded hover:bg-white/[0.08] disabled:opacity-30 transition"
              aria-label="Next question"
            >
              <ChevronDownIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Тело вопроса */}
      <div className="p-4 space-y-3.5">
        {/* Номер и формулировка вопроса */}
        <div className="flex items-start gap-2.5">
          <span className="size-5.5 rounded-md flex items-center justify-center text-xs font-semibold bg-white/[0.07] text-foreground/80 shrink-0 mt-0.5 font-mono">
            {clampedIndex}
          </span>
          <div className="flex-1">
            <h4 className="text-[15px] font-medium leading-snug text-foreground">
              {activeQuestion.title}
            </h4>
            {activeQuestion.description && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {activeQuestion.description}
              </p>
            )}
          </div>
        </div>

        {/* Варианты ответов */}
        {kind !== "text" && activeQuestion.options && activeQuestion.options.length > 0 && (
          <div className="space-y-1.5 pt-0.5">
            {activeQuestion.options.map((opt, idx) => {
              const checked = selectedIds.includes(opt.id);
              const badgeLetter = optionBadge(idx);

              return (
                <button
                  key={opt.id || `${opt.label}-${idx}`}
                  type="button"
                  disabled={busy}
                  onClick={() => handleSelectOption(opt.id)}
                  className={cn(
                    "w-full text-left rounded-xl border px-3 py-2 flex items-center gap-2.5 transition-all duration-150 group",
                    checked
                      ? "border-primary/60 bg-primary/10 text-foreground shadow-[0_0_12px_rgba(var(--primary),0.12)]"
                      : "border-white/[0.08] bg-white/[0.03] text-foreground/90 hover:bg-white/[0.06] hover:border-white/20 active:scale-[0.995]",
                  )}
                >
                  <span
                    className={cn(
                      "size-5.5 rounded-md flex items-center justify-center text-[11px] font-bold uppercase tracking-wider font-mono shrink-0 transition-colors",
                      checked
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "border border-white/10 bg-white/[0.05] text-muted-foreground group-hover:text-foreground",
                    )}
                  >
                    {badgeLetter}
                  </span>

                  <div className="min-w-0 flex-1 flex flex-col">
                    <span className="text-[13.5px] font-medium leading-snug">
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="text-[11.5px] leading-tight text-muted-foreground mt-0.5">
                        {opt.description}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            {/* Вариант ввода своего ответа */}
            {customEnabled && (
              <div
                className={cn(
                  "w-full rounded-xl border px-3 py-1.5 flex items-center gap-2.5 transition-all duration-150",
                  selectedIds.includes(CUSTOM_ID)
                    ? "border-primary/60 bg-primary/10 shadow-[0_0_12px_rgba(var(--primary),0.12)]"
                    : "border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]",
                )}
              >
                <span
                  className={cn(
                    "size-5.5 rounded-md flex items-center justify-center text-[11px] font-bold uppercase tracking-wider font-mono shrink-0 transition-colors",
                    selectedIds.includes(CUSTOM_ID)
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "border border-white/10 bg-white/[0.05] text-muted-foreground",
                  )}
                >
                  {optionBadge(activeQuestion.options.length)}
                </span>

                <input
                  type="text"
                  disabled={busy}
                  value={customText}
                  onChange={(e) => handleCustomChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) {
                      e.preventDefault();
                      handleNextOrSubmit();
                    }
                  }}
                  placeholder={
                    activeQuestion.customPlaceholder ?? "Type your answer"
                  }
                  className="w-full h-8 bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground/60 outline-none border-none focus:outline-none focus:ring-0"
                />
              </div>
            )}
          </div>
        )}

        {/* Текстовый ввод для kind === 'text' */}
        {kind === "text" && (
          <textarea
            disabled={busy}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && canSubmit) {
                e.preventDefault();
                handleNextOrSubmit();
              }
            }}
            rows={3}
            placeholder={activeQuestion.placeholder ?? "Type your answer"}
            className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] p-3 text-[13.5px] text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary/60 focus:bg-white/[0.05] transition-all resize-y"
          />
        )}

        {/* Нижняя панель действий */}
        <div className="flex items-center justify-end gap-2 pt-1 border-t border-white/[0.06]">
          {allowSkip && (
            <button
              type="button"
              disabled={busy}
              onClick={handleSkip}
              className="text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg hover:bg-white/[0.06] transition"
            >
              {resolvedSkipLabel}
            </button>
          )}

          <button
            type="button"
            disabled={!canSubmit || busy}
            onClick={handleNextOrSubmit}
            className={cn(
              "text-xs font-semibold px-4 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shadow-sm",
              canSubmit && !busy
                ? "border border-primary/40 bg-primary text-primary-foreground shadow-[0_0_10px_rgba(var(--primary),0.3)] hover:scale-105 hover:bg-primary/90 active:scale-95 cursor-pointer"
                : "border border-white/5 bg-white/[0.05] text-muted-foreground/40 cursor-not-allowed",
            )}
          >
            <span>{primaryLabel}</span>
            {isLastQuestion && <SendIcon size={12} className="opacity-80" />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default QuestionTool;
