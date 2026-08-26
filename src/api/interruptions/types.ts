export const PERMISSION_VALUES = ["once", "always", "reject"] as const;

export type PermissionResponse = (typeof PERMISSION_VALUES)[number];

export function isPermissionResponse(
  v: string | undefined,
): v is PermissionResponse {
  return (PERMISSION_VALUES as readonly (string | undefined)[]).includes(v);
}

export type InterruptionKind = "permission" | "question";

export interface InterruptionOption {
  label: string;
  value: string;
  description: string;
  denial: boolean;
}

export interface Interruption {
  kind: InterruptionKind;
  id: string | null;
  title: string;
  prompt: string;
  detail: string;
  options: InterruptionOption[];
  allowCustom: boolean;
  raw: unknown;
}

export interface PermissionLike {
  id?: unknown;
  tool?: unknown;
  input?: unknown;
}

export interface ToolPresentation {
  action: string;
  detail?: string | undefined;
}

export type ReplyPlan =
  | { transport: "permission"; id: string; response: PermissionResponse }
  | { transport: "question"; id: string; answers: string[][] }
  | { transport: "none"; reason: string };

export interface ReplyContext {
  pendingQuestionId?: string | null;
}

export interface BarPresentation {
  visible: boolean;
  active: Interruption | null;
  queued: number;
  collapsible: boolean;
}

export const QUESTION_TOOL = "question";

export interface QuestionPartLike {
  type?: unknown;
  tool?: unknown;
  callID?: unknown;
  state?: unknown;
  input?: unknown;
}

export interface MessageLike {
  parts?: unknown;
}

export interface FeedLine {
  text: string;
  note: string;
}
