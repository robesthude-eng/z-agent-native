import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { type DiffOptions, diffLines, diffStatLabel } from "../lib/diff";

/**
 * Добавленное больше не зелёное. Различие строк держится на знаке `+`/`−` в
 * начале и на светлоте подложки — добавленное светлее фона, убранное темнее,
 * — а не на паре «зелёный/красный». Красный оставлен только за удалением:
 * это единственное действие здесь, которое теряет данные, и предупреждать о
 * нём цветом уместно.
 */
const OP_STYLES = {
  add: "bg-foreground/[0.07] text-foreground",
  del: "bg-destructive/10 text-destructive",
  ctx: "text-muted-foreground/80",
} as const;

const OP_SIGNS = { add: "+", del: "−", ctx: " " } as const;

/**
 * Показ построчных изменений: правка агента (`edit`-инструмент) или
 * несохранённый черновик в редакторе workspace.
 *
 * Номера строк показываются с обеих сторон — без них по diff'у нельзя понять,
 * какое место файла затронуто, а именно за этим его и открывают.
 */
export default function DiffView({
  oldText,
  newText,
  emptyLabel = "Изменений нет",
  className,
  options,
}: {
  oldText: string;
  newText: string;
  emptyLabel?: string;
  className?: string;
  options?: DiffOptions;
}) {
  const result = useMemo(
    () => diffLines(oldText, newText, options),
    [oldText, newText, options],
  );

  if (result.hunks.length === 0) {
    return (
      <p className="px-1 py-2 text-[11.5px] text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card/60",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Изменения
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {diffStatLabel(result)}
        </span>
        {result.truncated && (
          <span
            className="text-[11px] text-amber-400"
            title="Изменённый фрагмент слишком большой — показан целыми блоками"
          >
            блоками
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-auto font-mono text-[11.5px] leading-relaxed">
        {result.hunks.map((hunk, hunkIndex) => (
          <div key={`${hunk.oldStart}-${hunk.newStart}`}>
            {hunkIndex > 0 && (
              // Разрыв между участками: без него два далёких изменения читаются
              // как одно непрерывное.
              <div className="border-y border-border/60 bg-muted/30 px-2.5 py-0.5 text-[10.5px] text-muted-foreground/70">
                ⋯ пропущено
              </div>
            )}
            {hunk.lines.map((line) => (
              // Ключ по номерам строк: в пределах файла пара (oldNo, newNo)
              // уникальна для каждой операции, а индекс сдвигался бы при
              // пересчёте участков и переносил бы узлы между строками.
              <div
                key={`${line.op}${line.oldNo ?? ""}:${line.newNo ?? ""}`}
                className={cn("flex gap-2 px-2.5", OP_STYLES[line.op])}
              >
                <span className="w-8 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums">
                  {line.oldNo ?? ""}
                </span>
                <span className="w-8 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums">
                  {line.newNo ?? ""}
                </span>
                <span className="w-2 shrink-0 select-none">
                  {OP_SIGNS[line.op]}
                </span>
                <span className="whitespace-pre-wrap break-all">
                  {line.text || " "}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
