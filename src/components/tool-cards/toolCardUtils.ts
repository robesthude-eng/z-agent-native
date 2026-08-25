import { isRecord, strField } from "../../api/eventGuards";
import type { ToolPart, ToolState } from "../../api/types";
import { t, tf } from "@/i18n";

export function fmt(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getState(part: ToolPart): string {
  const s = part.state;
  if (typeof s === "string") return s === "pending" ? "running" : s;
  if (s && typeof s === "object") {
    const status = (s as ToolState).status ?? "running";
    return status === "pending" ? "running" : status;
  }
  if (part.output !== undefined && part.output !== null) {
    return "completed";
  }
  return "running";
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

export function friendlyToolLabel(tool?: string): string {
  const kind = (tool || "").toLowerCase();
  if (kind === "bash" || kind === "shell" || kind === "cmd")
    return t("tool_card.komanda");
  if (kind === "read") return t("tool_card.chitaet_fayl");
  if (kind === "write") return t("tool_card.pishet_fayl");
  if (kind === "edit" || kind === "applypatch" || kind === "apply_patch")
    return t("tool_card.pravit_fayl");
  if (kind === "patch") return t("tool_card.primenyaet_patch");
  if (kind === "glob") return t("tool_card.ischet_fayly");
  if (kind === "grep") return t("tool_card.ischet_po_tekstu");
  if (kind === "ls" || kind === "list") return t("tool_card.smotrit_papku");
  if (kind === "webfetch" || kind === "fetch")
    return t("tool_card.zagruzhaet_stranicu");
  if (kind === "websearch" || kind === "search")
    return t("tool_card.ischet_v_internete");
  if (kind === "ssh_tool" || kind === "ssh")
    return t("tool_card.rabotaet_s_udalennym_serverom");
  if (kind === "task") return t("tool_card.podzadacha");
  if (kind === "todowrite" || kind === "todo")
    return t("tool_card.obnovlyaet_plan");
  if (kind === "question") return t("tool_card.vopros");
  if (kind === "ensure_environment") return t("tool_card.gotovit_okruzhenie");
  if (kind === "environment_status")
    return t("tool_card.proveryaet_okruzhenie");
  if (kind === "repo_map") return t("tool_card.smotrit_strukturu_proekta");
  if (kind === "generate_image") return t("tool_card.risuet_izobrazhenie");
  if (kind === "generate_speech") return t("tool_card.ozvuchivaet_tekst");
  if (kind === "render_document") return t("tool_card.sobiraet_dokument");
  if (kind === "render_video") return t("tool_card.sobiraet_video");
  if (kind === "convert_media") return t("tool_card.konvertiruet_fayl");
  if (kind === "media_info") return t("tool_card.smotrit_svedeniya_o_fayle");
  if (!tool) return t("tool_card.instrument");
  return tf("tool_card.instrument_0", [tool]);
}
