import {
  PERMISSION_VALUES,
  type PermissionResponse,
  isPermissionResponse,
  type Interruption,
  type InterruptionOption,
  type PermissionLike,
  type ToolPresentation,
  type ReplyPlan,
  type ReplyContext,
} from "./types";
import { t, tf } from "@/i18n";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? (o[k] as string) : "";

const pick = (o: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = str(o, k);
    if (v) return v;
  }
  return "";
};

const PERMISSION_LABELS: Record<
  PermissionResponse,
  { label: string; description: string; denial: boolean }
> = {
  once: {
    label: t("interruptions.razreshit"),
    description: t("interruptions.tolko_etot_vyzov"),
    denial: false,
  },
  always: {
    label: t("interruptions.vsegda"),
    description: t("interruptions.do_konca_tekuschey_sessii"),
    denial: false,
  },
  reject: { label: t("interruptions.otklonit"), description: "", denial: true },
};

const PERMISSION_OPTIONS: InterruptionOption[] = PERMISSION_VALUES.map((v) => ({
  value: v,
  ...PERMISSION_LABELS[v],
}));

export function normalizePermission(
  req: PermissionLike,
  present: (tool: string, input: unknown) => ToolPresentation,
): Interruption {
  const tool = typeof req.tool === "string" && req.tool ? req.tool : "tool";
  const { action, detail } = present(tool, req.input);
  return {
    kind: "permission",
    id: typeof req.id === "string" && req.id ? req.id : null,
    title: t("interruptions.zapros_razresheniya"),
    prompt: action,
    detail: detail ?? "",
    options: PERMISSION_OPTIONS,
    allowCustom: false,
    raw: req.input,
  };
}

export function normalizeQuestion(q: unknown, id: string | null): Interruption {
  const rec = isRecord(q) ? q : {};
  const rawOptions = Array.isArray(rec.options) ? rec.options : [];
  const options: InterruptionOption[] = rawOptions.map((o) => {
    if (typeof o === "string") {
      return { label: o, value: o, description: "", denial: false };
    }
    const or = isRecord(o) ? o : {};
    const label = pick(or, "label", "text");
    return {
      label,
      value: label,
      description: pick(or, "description", "desc"),
      denial: false,
    };
  });
  const allowCustom =
    typeof rec.allowCustomResponse === "boolean"
      ? rec.allowCustomResponse
      : typeof rec.allowCustom === "boolean"
        ? rec.allowCustom
        : true;
  return {
    kind: "question",
    id,
    title: t("interruptions.vopros_agenta"),
    prompt: pick(rec, "question", "text"),
    detail: "",
    options,
    allowCustom,
    raw: q,
  };
}

export function replyTransport(
  interruption: Interruption,
  ctx: ReplyContext = {},
): ReplyPlan["transport"] {
  if (interruption.kind === "permission") {
    return interruption.id ? "permission" : "none";
  }
  return (ctx.pendingQuestionId ?? interruption.id) ? "question" : "none";
}

export function replyPlan(
  interruption: Interruption,
  answer: string[],
  ctx: ReplyContext = {},
): ReplyPlan {
  return batchReplyPlan([interruption], [answer], ctx);
}

export function batchReplyPlan(
  interruptions: readonly Interruption[],
  answers: readonly (readonly string[])[],
  ctx: ReplyContext = {},
): ReplyPlan {
  const head = interruptions[0];
  if (!head)
    return { transport: "none", reason: t("interruptions.nechego_otpravlyat") };

  const values = interruptions.map((_, idx) =>
    (answers[idx] ?? []).map((a) => a.trim()).filter(Boolean),
  );
  if (values.every((v) => v.length === 0)) {
    return { transport: "none", reason: t("interruptions.pustoy_otvet") };
  }

  switch (replyTransport(head, ctx)) {
    case "permission": {
      if (interruptions.length > 1) {
        return {
          transport: "none",
          reason: t("interruptions.razresheniya_otpravlyayutsya_po_odnomu"),
        };
      }
      const v = values[0]?.[0];
      if (!isPermissionResponse(v)) {
        return {
          transport: "none",
          reason: tf("interruptions.nedopustimyy_otvet_0", [v ?? ""]),
        };
      }
      return {
        transport: "permission",
        id: head.id ?? "",
        response: v,
      };
    }
    case "question":
      return {
        transport: "question",
        id: ctx.pendingQuestionId ?? head.id ?? "",
        answers: values.map((v) => [...v]),
      };
    case "none":
      return {
        transport: "none",
        reason:
          head.kind === "question"
            ? t("interruptions.vopros_esche_ne_podtverzhden_serverom")
            : t("interruptions.net_identifikatora_razresheniya"),
      };
    default:
      return {
        transport: "none",
        reason: t("interruptions.neizvestnyy_transport_otveta"),
      };
  }
}

export function answerAsMessage(
  interruption: Interruption,
  values: string[],
): string {
  const ctx = interruption.prompt.trim();
  const body = values.join(", ");
  return ctx ? `${ctx}: ${body}` : body;
}

export function planCancelsTurn(_plan: ReplyPlan): boolean {
  return false;
}
