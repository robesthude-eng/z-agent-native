import { toolPhase } from "@/lib/toolStatus";
import { isRecord, strField } from "../../api/eventGuards";
import type { ToolPart, ToolState } from "../../api/types";

// Подпись переехала в lib: её просят и нижний индикатор, и шапка группы, а
// тянуть ради строки модуль карточки со всем деревом его импортов не нужно.
export { friendlyToolLabel } from "@/lib/toolLabels";

export function fmt(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Фаза вызова для карточки: тот же разбор, что у шапки группы и индикатора. */
export function getState(part: ToolPart): string {
  return toolPhase(part);
}

export function getMetadata(part: ToolPart): unknown {
  const s = part.state;
  if (s && typeof s === "object") return (s as ToolState).metadata;
  return undefined;
}

export function getInput(part: ToolPart): unknown {
  const s = part.state;
  if (s && typeof s === "object") return (s as ToolState).input;
  return part.input;
}

export function getOutput(part: ToolPart): string {
  const s = part.state;
  let out: unknown;
  if (s && typeof s === "object") out = (s as ToolState).output;
  else out = part.output;
  if (out == null && s && typeof s === "object") {
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

export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

export function looksLikePath(v: string): boolean {
  return /[\\/]/.test(v) && !/\s/.test(v);
}

export function getSummary(part: ToolPart): string {
  const clip = (v: string) => (v.length > 72 ? `${v.slice(0, 69)}…` : v);
  const s = part.state;
  if (s && typeof s === "object") {
    const title = (s as ToolState).title;
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

export interface ChangeStats {
  added: number;
  removed: number;
}

function countLines(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

/**
 * «+N −M» для шагов, меняющих файлы: по сводке сервера (metadata.fileChange),
 * а для старых сообщений без неё — по аргументам вызова.
 */
export function getChangeStats(part: ToolPart): ChangeStats | null {
  const tool = String(part.tool || "").toLowerCase();
  if (tool !== "edit" && tool !== "write" && tool !== "multiedit") return null;
  const s = part.state;
  const meta =
    s && typeof s === "object"
      ? ((s as ToolState).metadata as Record<string, unknown> | undefined)
      : undefined;
  const change = meta?.fileChange as Record<string, unknown> | undefined;
  if (change && typeof change === "object") {
    if (change.kind === "edit")
      return {
        added: Number(change.added) || 0,
        removed: Number(change.removed) || 0,
      };
    return {
      added: Number(change.lines) || 0,
      removed: Number(change.previousLines) || 0,
    };
  }
  const input = getInput(part) as Record<string, unknown> | undefined;
  if (!input) return null;
  if (tool === "write") return { added: countLines(input.content), removed: 0 };
  const oldText = input.oldText ?? input.oldString ?? input.old_string;
  const newText = input.newText ?? input.newString ?? input.new_string;
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  return { added: countLines(newText), removed: countLines(oldText) };
}
