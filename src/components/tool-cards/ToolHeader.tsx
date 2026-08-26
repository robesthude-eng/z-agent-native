import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";
import { t } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { toolIcon } from "../../utils/toolUtils";
import { friendlyToolLabel } from "./toolCardUtils";

interface ToolHeaderProps {
  toolName: string;
  summary: string;
  state: string;
  open: boolean;
  onToggle: () => void;
  output: string;
}

export function ToolHeader({
  toolName,
  summary,
  state,
  open,
  onToggle,
  output,
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
      onClick={onToggle}
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-left cursor-pointer transition select-none",
        open ? "bg-muted/40 border-b border-border/50" : "hover:bg-muted/30",
      )}
    >
      <span className="shrink-0 text-muted-foreground">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {toolIcon(toolName)}
      </span>
      <span className="font-medium text-[12px] text-foreground shrink-0">
        {friendlyToolLabel(toolName)}
      </span>
      {summary && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground font-mono">
          {summary}
        </span>
      )}
      {!summary && <span className="flex-1" />}

      <div className="flex items-center gap-1.5 shrink-0">
        {state === "running" && (
          <span className="flex items-center gap-1 text-[11px] text-sky-500 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />
            {t("agent_activity.rabotaet")}
          </span>
        )}
        {state === "completed" && (
          <span className="text-[10px] text-emerald-500 font-medium px-1.5 py-0.5 rounded bg-emerald-500/10">
            ✓
          </span>
        )}
        {state === "error" && (
          <span className="text-[10px] text-rose-500 font-medium px-1.5 py-0.5 rounded bg-rose-500/10">
            ✕ {t("changes_panel.oshibka")}
          </span>
        )}

        {output && (
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition opacity-0 group-hover:opacity-100"
            title={t("copy_button.kopirovat")}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
      </div>
    </div>
  );
}
