import { Sparkles } from "lucide-react";
import { t } from "@/i18n";
import type { Message, ToolPart } from "../../api/types";
import { toWorkspaceRelPath } from "../../lib/workspacePath";
import { WorkspaceFileChip } from "../AttachmentChip";
import { toolCompleted } from "./turnSummary";

export function GeneratedFiles({ message }: { message: Message }) {
  const pathsInText = new Set<string>();
  for (const p of message.parts || []) {
    if (p.type !== "text" || typeof (p as { text?: unknown }).text !== "string")
      continue;
    const text = (p as { text: string }).text;
    for (const m of text.matchAll(/^📎 .+? → (\S+)/gm)) {
      const path = toWorkspaceRelPath(m[1] || "");
      if (path) pathsInText.add(path);
    }
  }

  const files = new Map<string, string>();
  for (const p of message.parts || []) {
    if (p.type !== "tool") continue;
    const tool = String((p as ToolPart).tool || "").toLowerCase();
    if (tool !== "write" || !toolCompleted(p as ToolPart)) continue;
    const state = (p as ToolPart).state;
    const input =
      state && typeof state === "object" ? state.input : (p as ToolPart).input;
    if (!input || typeof input !== "object") continue;
    const raw =
      (input as Record<string, unknown>).filePath ??
      (input as Record<string, unknown>).path;
    if (typeof raw !== "string") continue;
    const path = toWorkspaceRelPath(raw);
    if (!path || pathsInText.has(path)) continue;
    const name = path.split("/").pop() || path;
    files.set(path, name);
  }

  if (files.size === 0) return null;
  return (
    <div className="mt-3 space-y-1.5 pt-1">
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3 text-emerald-400" />
        <span>{t("message_item.sozdano_assistentom_v_workspace")}</span>
        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-medium text-emerald-400">
          {files.size}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[...files].map(([path, name]) => (
          <WorkspaceFileChip
            key={path}
            name={name}
            path={path}
            meta={path !== name ? path : undefined}
          />
        ))}
      </div>
    </div>
  );
}
