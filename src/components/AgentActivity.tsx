import { ChevronRight, Wrench } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Compact activity disclosure for autonomous turns.
 *
 * The chain is open while the agent is working and collapses by itself once
 * the turn is done, so live cards (reasoning bursts, streaming command output)
 * stay visible exactly while they mean something, and the finished transcript
 * stays focused on the task and its result. An explicit click always wins over
 * that automatic behaviour for the rest of the session.
 */

/** «1 шаг», «2 шага», «5 шагов» — русская плюрализация.
 *
 * Раньше тут были «действия», но внутрь цепочки теперь попадают и
 * рассуждения, а они не действия. Счёт и слово должны совпадать с тем,
 * что человек увидит, развернув блок. */
function formatSteps(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 19) return `${n} шагов`;
  if (mod10 === 1) return `${n} шаг`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} шага`;
  return `${n} шагов`;
}

const AgentActivity = ({
  count,
  running,
  hasError,
  children,
}: {
  count: number;
  running: boolean;
  hasError: boolean;
  children: ReactNode;
}) => {
  // null — пользователь ещё не вмешивался: решает статус хода.
  const [choice, setChoice] = useState<boolean | null>(null);
  const expanded = choice ?? running;

  const status = running
    ? "Работает"
    : hasError
      ? "Завершено с ошибкой"
      : "Готово";

  return (
    <div className="not-prose my-1">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${status}, ${formatSteps(count)}. Показать подробности`}
        className={cn(
          "group/activity flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent/30",
          hasError && !running && "text-red-400",
        )}
        onClick={() => setChoice(!expanded)}
      >
        <span className="shrink-0 text-muted-foreground/50">
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </span>
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground",
            running && "text-foreground",
          )}
        >
          <Wrench className="h-[15px] w-[15px]" />
        </span>
        <span className="text-[13px] font-medium text-foreground/85">
          {!running && !hasError ? "✓ " : ""}
          {status}
        </span>
        <span className="text-[11.5px] text-muted-foreground/70">
          · {formatSteps(count)}
        </span>
        {running && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
        )}
        <span className="flex-1" />
        <span className="hidden text-[10.5px] text-muted-foreground/55 sm:inline">
          подробности
        </span>
      </button>
      {expanded && (
        <div className="oc-card-open ml-[9px] space-y-0.5 border-l border-border/60 pl-3">
          {children}
        </div>
      )}
    </div>
  );
};

export default memo(AgentActivity);
