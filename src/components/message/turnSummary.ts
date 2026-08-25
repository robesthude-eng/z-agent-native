import type { Message, ToolPart } from "../../api/types";
import { isAbortedError } from "../../api/eventGuards";
import { wasStoppedByUser } from "../../lib/stopUx";
import { toWorkspaceRelPath } from "../../lib/workspacePath";
import { t, tf } from "@/i18n";

export type TaskOutcomeStatus =
  | "completed"
  | "partial"
  | "needs_input"
  | "failed"
  | "cancelled";

export function taskOutcomeStatus(message: Message): TaskOutcomeStatus | null {
  const raw = (
    message.info as
      | ({ outcome?: { status?: unknown } } & Record<string, unknown>)
      | undefined
  )?.outcome?.status;
  return raw === "completed" ||
    raw === "partial" ||
    raw === "needs_input" ||
    raw === "failed" ||
    raw === "cancelled"
    ? raw
    : null;
}

export function strategyChanged(message: Message): boolean {
  return (
    (
      message.info as
        | ({ strategy?: { changed?: unknown } } & Record<string, unknown>)
        | undefined
    )?.strategy?.changed === true
  );
}

export function toolStateStatus(part: ToolPart): string | undefined {
  const state = part.state;
  return typeof state === "string"
    ? state
    : state && typeof state === "object"
      ? state.status
      : undefined;
}

export function toolCompleted(part: ToolPart): boolean {
  const status = toolStateStatus(part);
  return (
    status === "completed" ||
    status === "success" ||
    (status == null && part.output != null)
  );
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return tf("message_item.0_s", [seconds]);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60)
    return rest
      ? tf("message_item.0_min_1_s", [minutes, rest])
      : tf("message_item.0_min", [minutes]);
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes
    ? tf("message_item.0_ch_1_min", [hours, restMinutes])
    : tf("message_item.0_ch", [hours]);
}

export function toolInput(part: ToolPart): Record<string, unknown> | null {
  const state = part.state;
  const input = state && typeof state === "object" ? state.input : part.input;
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : null;
}

export function addWorkspacePath(paths: Set<string>, raw: unknown) {
  if (typeof raw !== "string") return;
  const path = toWorkspaceRelPath(raw);
  if (path) paths.add(path);
}

export function assistantTurnSummary(messages: Message[]) {
  let startedAt: number | null = null;
  let completedAt: number | null = null;
  let failed = false;
  let stopped = false;
  let needsInput = false;
  let outcomeStatus: TaskOutcomeStatus | null = null;
  let anonymousAction = 0;
  const actions = new Set<string>();
  const changedFiles = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const start = message.time?.created ?? message.info?.time?.created;
    const end = message.time?.completed ?? message.info?.time?.completed;
    if (typeof start === "number") {
      startedAt = startedAt == null ? start : Math.min(startedAt, start);
    }
    if (typeof end === "number") {
      completedAt = completedAt == null ? end : Math.max(completedAt, end);
    }
    const explicitOutcome = taskOutcomeStatus(message);
    if (explicitOutcome) outcomeStatus = explicitOutcome;
    if (message.info?.error) {
      if (isAbortedError(message.info.error)) stopped = true;
      else failed = true;
    }
    if (wasStoppedByUser(message)) stopped = true;

    for (const part of message.parts ?? []) {
      if (part.type !== "tool") continue;
      const toolPart = part as ToolPart;
      const tool = String(toolPart.tool || "").toLowerCase();
      const toolStatus = toolStateStatus(toolPart);
      if (
        tool === "question" &&
        (toolStatus === "running" ||
          toolStatus === "pending" ||
          toolStatus === "waiting")
      ) {
        needsInput = true;
      }
      actions.add(
        toolPart.callID ||
          toolPart.id ||
          `${message.id}:tool:${anonymousAction++}`,
      );
      if (!toolCompleted(toolPart)) continue;
      const input = toolInput(toolPart);
      if (!input) continue;

      if (tool === "write" || tool === "edit") {
        addWorkspacePath(changedFiles, input.path ?? input.filePath);
      }
      if (tool === "apply_patch" || tool === "applypatch" || tool === "patch") {
        const patch = input.patch;
        if (typeof patch === "string") {
          for (const line of patch.split("\n")) {
            if (!line.startsWith("+++ ")) continue;
            let path = line.slice(4).trim().split("\t")[0] || "";
            if (!path || path === "/dev/null") continue;
            path = path.replace(/^b\//, "");
            addWorkspacePath(changedFiles, path);
          }
        }
      }
    }
  }

  const durationMs =
    startedAt != null && completedAt != null && completedAt >= startedAt
      ? completedAt - startedAt
      : null;

  return {
    actionsCount: actions.size,
    changedFiles: [...changedFiles],
    durationMs,
    failed,
    stopped,
    needsInput,
    outcomeStatus,
  };
}
