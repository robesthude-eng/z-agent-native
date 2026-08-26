import { t } from "@/i18n";
import { normalizeQuestion } from "./normalization";
import {
  type BarPresentation,
  type FeedLine,
  type Interruption,
  type MessageLike,
  QUESTION_TOOL,
  type QuestionPartLike,
  type ReplyContext,
  type ReplyPlan,
} from "./types";

export const BAR_COLLAPSE_LINES = 3;
const BAR_CHARS_PER_LINE = 64;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function isInterruptionBarEnabled(): boolean {
  try {
    return import.meta.env?.VITE_INTERRUPTION_BAR !== "0";
  } catch {
    return true;
  }
}

export function barPresentation(
  interruptions: readonly Interruption[],
): BarPresentation {
  const ordered = [
    ...interruptions.filter((i) => i.kind === "permission"),
    ...interruptions.filter((i) => i.kind === "question"),
  ];
  const active = ordered[0] ?? null;
  if (!active) {
    return { visible: false, active: null, queued: 0, collapsible: false };
  }
  const text = `${active.prompt}\n${active.detail}`.trim();
  return {
    visible: true,
    active,
    queued: ordered.length - 1,
    collapsible: isLongForBar(text),
  };
}

export function isLongForBar(text: string): boolean {
  if (!text) return false;
  const lines = text.split("\n");
  if (lines.length > BAR_COLLAPSE_LINES) return true;
  const rendered = lines.reduce(
    (n, line) => n + Math.max(1, Math.ceil(line.length / BAR_CHARS_PER_LINE)),
    0,
  );
  return rendered > BAR_COLLAPSE_LINES;
}

function partStatus(part: QuestionPartLike): string {
  const s = part.state;
  if (typeof s === "string") return s === "pending" ? "running" : s;
  if (isRecord(s)) {
    const status = typeof s.status === "string" ? s.status : "running";
    return status === "pending" ? "running" : status;
  }
  return "running";
}

function partInput(part: QuestionPartLike): unknown {
  return isRecord(part.state) ? part.state.input : part.input;
}

export function isBarQuestionPart(part: unknown): part is QuestionPartLike {
  if (!isRecord(part)) return false;
  if (part.type !== "tool") return false;
  if (part.tool !== QUESTION_TOOL) return false;
  return partStatus(part as QuestionPartLike) === "running";
}

export function isInterruptedQuestionPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (part.type !== "tool") return false;
  if (part.tool !== QUESTION_TOOL) return false;
  return partStatus(part as QuestionPartLike) === "error";
}

export function answerFromFeed(
  interruption: Interruption,
  text: string,
): string[] | null {
  const asked = interruption.prompt.trim();
  const body = text.trim();
  if (!body) return null;

  let tail = "";
  if (asked) {
    const prefix = `${asked}:`;
    const line = body.split("\n").find((l) => l.trim().startsWith(prefix));
    if (!line) return null;
    tail = line.trim().slice(prefix.length).trim();
  } else {
    if (body.includes("\n")) return null;
    tail = body;
  }
  if (!tail) return null;

  const pieces = tail
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const labels = new Set(interruption.options.map((o) => o.label));
  if (pieces.length > 1 && pieces.every((p) => labels.has(p))) return pieces;
  return [tail];
}

export function replyTextAfterCall<M extends MessageLike>(
  messages: readonly M[],
  callId: string | null,
  textOf: (m: M) => string,
): string {
  if (!callId) return "";
  let found = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const parts = messages[i]?.parts;
    if (!Array.isArray(parts)) continue;
    if (parts.some((p) => isRecord(p) && p.callID === callId)) {
      found = i;
      break;
    }
  }
  if (found < 0) return "";
  for (let i = found + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    const record = m as unknown as Record<string, unknown>;
    const role = isRecord(record.info)
      ? typeof record.info.role === "string"
        ? record.info.role
        : ""
      : "";
    const own = typeof record.role === "string" ? String(record.role) : "";
    if ((own || role) === "user") return textOf(m);
  }
  return "";
}

export function optionsLayout(interruption: Interruption): "list" | "actions" {
  return interruption.kind === "permission" ? "actions" : "list";
}

export function activeQuestion(
  messages: readonly MessageLike[],
): { interruptions: Interruption[]; callId: string | null } | null {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const parts = messages[m]?.parts;
    if (!Array.isArray(parts)) continue;
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p];
      if (!isBarQuestionPart(part)) continue;
      const raw = partInput(part);
      const list =
        isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : [raw];
      const callId = typeof part.callID === "string" ? part.callID : null;
      return {
        interruptions: list.map((q) => normalizeQuestion(q, null)),
        callId,
      };
    }
  }
  return null;
}

export function feedTrace(
  interruption: Interruption,
  answer: readonly string[] | null,
): string | null {
  if (!answer || answer.length === 0) return null;
  const asked = interruption.prompt.trim();
  const given = answer.join(", ");
  return asked ? `${asked} — ${given}` : given;
}

export function questionFeedLine(
  interruption: Interruption,
  answer: readonly string[] | null,
): FeedLine {
  const trace = feedTrace(interruption, answer);
  if (trace) return { text: trace, note: "" };
  const asked = interruption.prompt.trim();
  return { text: asked || t("interruptions.vopros_agenta"), note: "" };
}

export function hasQuestionPart(message: MessageLike): boolean {
  const parts = message.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (p) => isRecord(p) && p.type === "tool" && p.tool === QUESTION_TOOL,
  );
}

export function replyWarning(_plan: ReplyPlan): string | null {
  return null;
}

export function barWarning(
  _interruption: Interruption,
  _ctx: ReplyContext = {},
): string | null {
  return null;
}
