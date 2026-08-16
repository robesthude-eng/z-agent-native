import { ChevronRight, Wrench } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Compact activity disclosure for autonomous turns.
 *
 * Tool calls are implementation details, so the chain stays collapsed even
 * while the agent is working. The user can still open it at any time to audit
 * commands, file operations and reasoning. This keeps the chat focused on the
 * task and result instead of streaming a wall of technical cards.
 */

/** «1 действие», «2 действия», «5 действий» — русская плюрализация. */
function formatActions(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 19) return `${n} действий`;
  if (mod10 === 1) return `${n} действие`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} действия`;
  return `${n} действий`;
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
  const [expanded, setExpanded] = useState(false);

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
        aria-label={`${status}, ${formatActions(count)}. Показать подробности`}
        className={cn(
          "group/activity flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent/30",
          hasError && !running && "text-red-400",
        )}
        onClick={() => setExpanded((value) => !value)}
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
          · {formatActions(count)}
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
