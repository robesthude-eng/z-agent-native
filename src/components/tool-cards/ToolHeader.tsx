import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";
import { t } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { friendlyToolLabel } from "@/lib/toolLabels";
import { cn } from "@/lib/utils";
import { toolIcon } from "../../utils/toolUtils";
import type { ChangeStats } from "./toolCardUtils";

interface ToolHeaderProps {
  toolName: string;
  summary: string;
  state: string;
  open: boolean;
  onToggle: () => void;
  output: string;
  stats?: ChangeStats | null;
}

export function ToolHeader({
  toolName,
  summary,
  state,
  open,
  onToggle,
  output,
  stats = null,
}: ToolHeaderProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!output) return;
    copyText(output).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        toast("success", t("copy_button.skopirovano"));
      }
    });
  };

  return (
    <div
      className={cn(
        "chat-tool-header flex items-center gap-1.5 pr-1 transition select-none text-muted-foreground",
        open ? "border-b border-border/50" : "hover:bg-muted/30 rounded-md",
      )}
    >
      {/*
        Шапка — кнопка, а не div с onClick. Соседние уровни раскрытия (цепочка
        и группа) — кнопки с aria-expanded, а самая внутренняя карточка была
        недоступна с клавиатуры и не объявляла своё состояние. Кнопка
        копирования вынесена наружу: кнопка внутри кнопки — невалидный HTML.
      */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="chat-tool-toggle flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left cursor-pointer"
      >
        <span className="shrink-0 text-muted-foreground">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {toolIcon(toolName)}
        </span>
        <span className="chat-tool-label text-muted-foreground shrink-0">
          {friendlyToolLabel(toolName)}
        </span>
        {summary && (
          <span className="chat-tool-description min-w-0 flex-1 truncate text-muted-foreground font-mono">
            {summary}
          </span>
        )}
        {!summary && <span className="flex-1" />}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            {stats.added > 0 && (
              <span className="text-emerald-400">+{stats.added}</span>
            )}
            {stats.added > 0 && stats.removed > 0 && " "}
            {stats.removed > 0 && (
              <span className="text-rose-400">−{stats.removed}</span>
            )}
          </span>
        )}
      </button>

      <div className="flex items-center gap-1.5 shrink-0">
        {state === "running" && (
          <span className="flex items-center gap-1 text-[11px] text-sky-500 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />
            {t("agent_activity.rabotaet")}
          </span>
        )}
        {state === "completed" && (
          <span className="text-[11px] text-emerald-500 font-medium px-1">
            ✓
          </span>
        )}
        {state === "error" && (
          <span className="text-[10px] text-rose-500 font-medium px-1.5 py-0.5 rounded bg-rose-500/10">
            ✕ {t("changes_panel.oshibka")}
          </span>
        )}

        {output && (
          // На таче hover не существует: скрываем только там, где есть мышь.
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            title={t("copy_button.kopirovat")}
            aria-label={t("copy_button.kopirovat")}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>
    </div>
  );
}
