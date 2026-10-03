import { ChevronRight } from "lucide-react";
import { memo, useState } from "react";
import { t } from "@/i18n";
import { friendlyToolLabel } from "@/lib/toolLabels";
import { toolPhase } from "@/lib/toolStatus";
import { cn } from "@/lib/utils";
import { isInterruptedQuestionPart } from "../api/interruptions";
import type { ToolPart } from "../api/types";
import { toolIcon } from "../utils/toolUtils";
import ToolCard from "./ToolCard";
import { getChangeStats } from "./tool-cards/toolCardUtils";

/**
 * Идентичность вызова инструмента. Индекс как ключ здесь опасен: группа
 * дорисовывается в реальном времени, и при вставке нового вызова состояние
 * карточки (раскрыта/свёрнута) переезжало бы на соседний вызов.
 * id/callID приходят с сервера; title — последний рубеж для старых версий.
 */
function partKey(part: ToolPart): string {
  if (part.id) return part.id;
  if (part.callID) return part.callID;
  const s = part.state;
  const title = s && typeof s === "object" ? s.title : undefined;
  return title || `tool:${part.tool ?? ""}`;
}

function groupLabel(tool: string | undefined, count: number): string {
  // Подпись берётся из той же таблицы, что у одиночной карточки: своя таблица
  // здесь означала бы, что один и тот же инструмент в ленте называется
  // по-разному — в группе одним словом, отдельной строкой другим.
  const label = friendlyToolLabel(
    typeof tool === "string" && tool ? tool : undefined,
  );
  return count === 1 ? label : `${label} · ${count}`;
}

const ToolGroup = ({ tool, parts }: { tool: string; parts: ToolPart[] }) => {
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  const anyRunning = parts.some((p) => toolPhase(p) === "running");
  // Условие то же, что в шапке цепочки (`MessageItem`), и берётся из одной
  // функции: оборванный вопрос — не ошибка группы, а способ доставить ответ.
  const anyError = parts.some(
    (p) => toolPhase(p) === "error" && !isInterruptedQuestionPart(p),
  );
  // Reference behavior: group stays open in real time while any item is running.
  const expanded = manuallyToggled ?? anyRunning;
  const toolName = typeof tool === "string" ? tool : "tool";

  /*
    Одна карточка — не группа. Шапка «Команда» над единственным вызовом
    повторяла подпись самой карточки и стоила лишнего клика: до вывода
    команды надо было раскрыть цепочку, потом группу, потом карточку.
    Состояние группы здесь не теряется: раскрывать было нечего.
  */
  const onlyPart = parts.length === 1 ? parts[0] : undefined;
  if (onlyPart) return <ToolCard part={onlyPart} />;

  // Какие файлы и сколько строк затронула группа правок — видно без раскрытия.
  const files = [
    ...new Set(
      parts
        .map((p) => {
          const title = (p.state as { title?: unknown } | undefined)?.title;
          return typeof title === "string" ? title.split("/").pop() || "" : "";
        })
        .filter(Boolean),
    ),
  ];
  const totals = parts.reduce(
    (acc, p) => {
      const s = getChangeStats(p);
      return s
        ? { added: acc.added + s.added, removed: acc.removed + s.removed }
        : acc;
    },
    { added: 0, removed: 0 },
  );
  const hasTotals = totals.added > 0 || totals.removed > 0;

  return (
    <div className="not-prose my-1">
      <button
        type="button"
        // Состояние раскрытия видно глазами по стрелке, но не скринридеру:
        // без aria-expanded кнопка звучала как обычная кнопка без последствий.
        aria-expanded={expanded}
        className="group/toolgrp flex w-full items-center gap-2 px-2 py-1.5 text-left rounded-lg hover:bg-accent/30 transition cursor-pointer"
        // Один клик переключает относительно видимого состояния (фикс двойного клика).
        onClick={() => setManuallyToggled(!expanded)}
      >
        <span className="text-muted-foreground/50 shrink-0">
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </span>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
          {toolIcon(toolName)}
        </span>
        <span className="text-[13px] font-medium text-foreground/85">
          {groupLabel(toolName, parts.length)}
        </span>
        {anyRunning && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse" />
        )}
        {!anyRunning && anyError && (
          <span className="text-[11px] font-medium text-red-400">
            {t("changes_panel.oshibka")}
          </span>
        )}
        {hasTotals && files.length > 0 && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground/75">
            {files.slice(0, 2).join(", ")}
            {files.length > 2 ? ` +${files.length - 2}` : ""}
          </span>
        )}
        <span className="flex-1" />
        {hasTotals && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            {totals.added > 0 && (
              <span className="text-emerald-400">+{totals.added}</span>
            )}
            {totals.added > 0 && totals.removed > 0 && " "}
            {totals.removed > 0 && (
              <span className="text-rose-400">−{totals.removed}</span>
            )}
          </span>
        )}
      </button>
      {expanded && (
        <div className="oc-card-open mt-1 ml-4 pl-3 border-l border-border/40 space-y-0.5">
          {parts.map((part) => (
            <ToolCard key={partKey(part)} part={part} />
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(ToolGroup);
