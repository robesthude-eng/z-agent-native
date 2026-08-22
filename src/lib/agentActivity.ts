import type { Message } from "@/api/types";
import { friendlyToolLabel } from "@/components/ToolCard";
import { t, tf } from "@/i18n";

/**
 * Реальное текущее действие агента для нижнего индикатора.
 *
 * Раньше индикатор показывал выдуманную цепочку «Анализ → Изменения →
 * Проверка» и одно из шести размытых описаний типа «анализирует проект»:
 * чтение файла, поиск в интернете и запуск тестов выглядели одинаково, а
 * стадии вообще не следовали за ходом. Здесь всё строится из фактических
 * частей сообщения: имён инструментов, их аргументов и статусов.
 */

export type ActivityState = "done" | "running" | "error";

export interface ActivityStep {
  key: string;
  label: string;
  detail: string;
  state: ActivityState;
}

export interface AgentActivity {
  /** Что агент делает прямо сейчас. */
  label: string;
  /** Над чем именно: файл, команда, запрос. */
  detail: string;
  /** Номер текущего действия в ходе. */
  step: number;
  /** След последних реальных действий. */
  steps: ActivityStep[];
}

interface LoosePart {
  type?: string;
  tool?: unknown;
  state?: unknown;
  output?: unknown;
  text?: unknown;
  title?: unknown;
  callID?: unknown;
}

const TRAIL_LIMIT = 3;
const DETAIL_LIMIT = 44;

/** Статус вызова: state приходит и строкой, и объектом `{ status }`. */
export function partActivityState(part: LoosePart): ActivityState {
  const st = part.state;
  const raw =
    typeof st === "string"
      ? st
      : st && typeof st === "object"
        ? String(
            (st as { status?: string }).status ??
              (part.output != null ? "completed" : "running"),
          )
        : part.output != null
          ? "completed"
          : "running";
  if (raw === "error" || raw === "failed") return "error";
  if (raw === "completed" || raw === "done" || raw === "success") return "done";
  return "running";
}

function shorten(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= DETAIL_LIMIT) return text;
  return `${text.slice(0, DETAIL_LIMIT - 1)}…`;
}

function inputOf(part: LoosePart): Record<string, unknown> {
  const st = part.state;
  const input =
    st && typeof st === "object" ? (st as { input?: unknown }).input : undefined;
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Цель действия берётся из аргументов самого инструмента, а не угадывается
 * по его имени: имена полей — из схем в server/native/tools.mjs.
 */
export function activityDetail(tool: string, part: LoosePart): string {
  const input = inputOf(part);
  const str = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string) : "";
  const t = tool.toLowerCase();
  if (t === "webfetch" || t === "fetch") {
    const url = str("url");
    try {
      return shorten(new URL(url).hostname);
    } catch {
      return shorten(url);
    }
  }
  if (t === "websearch" || t === "search" || t === "grep") return shorten(str("query"));
  if (t === "bash" || t === "shell" || t === "run_tests") return shorten(str("command"));
  if (t === "glob") return shorten(str("pattern"));
  if (t === "task") return shorten(str("agent") || str("description"));
  if (t === "ensure_environment" || t === "environment_status") return shorten(str("kind"));
  if (t === "apply_patch") return t("agent_activity.patch");
  if (t === "todowrite") {
    const todos = input.todos;
    return Array.isArray(todos) ? tf("agent_activity.0_p", [todos.length]) : "";
  }
  const filePath = str("path");
  if (filePath) return shorten(filePath.split("/").slice(-2).join("/"));
  return shorten(typeof part.title === "string" ? part.title : "");
}

/** Реальное состояние работы из частей последнего ответа агента. */
export function describeAgentActivity(
  messages: Message[] | undefined,
): AgentActivity {
  const list = messages ?? [];
  let last: Message | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const candidate = list[i];
    if (candidate?.role === "assistant") {
      last = candidate;
      break;
    }
  }
  const parts = (last?.parts ?? []) as LoosePart[];

  const steps: ActivityStep[] = [];
  parts.forEach((part, index) => {
    if (part?.type !== "tool") return;
    const tool = typeof part.tool === "string" ? part.tool : "";
    steps.push({
      key: typeof part.callID === "string" ? part.callID : `${tool}-${index}`,
      label: friendlyToolLabel(tool),
      detail: activityDetail(tool, part),
      state: partActivityState(part),
    });
  });

  let label = t("agent_activity.nachinaet");
  let detail = "";
  // Текущее действие ищем с конца: важно то, что идёт прямо сейчас.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part) continue;
    if (part.type === "tool") {
      const tool = typeof part.tool === "string" ? part.tool : "";
      if (partActivityState(part) === "running") {
        label = friendlyToolLabel(tool);
        detail = activityDetail(tool, part);
      } else {
        label = t("agent_activity.gotovit_sleduyuschiy_shag");
      }
      break;
    }
    if (part.type === "reasoning") {
      label = t("agent_activity.razmyshlyaet");
      break;
    }
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      label = t("agent_activity.pishet_otvet");
      break;
    }
  }

  return { label, detail, step: steps.length, steps: steps.slice(-TRAIL_LIMIT) };
}

export default describeAgentActivity;
