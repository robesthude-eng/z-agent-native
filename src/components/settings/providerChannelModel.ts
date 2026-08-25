import type { ProviderChannel, ProviderProtocol } from "@/api/providerChannels";
import { t } from "@/i18n";

export interface DraftChannel {
  id?: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  custom: boolean;
}

export interface ListedModel {
  id: string;
  name: string;
}

export type ProbeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; latencyMs: number }
  | { kind: "fail"; message: string };

export interface ManualRow {
  model_id: string;
  name: string | null;
  enabled: boolean;
  is_free: boolean;
}

export const API_FORMAT_LABELS: Record<ProviderProtocol, string> = {
  openai: "Chat Completions (/chat/completions)",
  anthropic: "Messages (/messages)",
  google: "Generate Content (:generateContent)",
};

export const PROTOCOL_PLACEHOLDERS: Record<ProviderProtocol, string> = {
  openai: "https://api.example.com/v1",
  anthropic: "https://api.example.com/v1",
  google: "https://api.example.com/v1beta",
};

const PROVIDER_STATUS_LABELS: Record<string, string> = {
  live: t("provider_channel_manager.katalog_dostupen"),
  cache: t("provider_channel_manager.katalog_iz_kesha"),
  unavailable: t("provider_channel_manager.katalog_nedostupen"),
  unauthorized: t("provider_channel_manager.net_dostupa_k_katalogu"),
  disabled: t("provider_channel_manager.vyklyuchen"),
  nokey: t("provider_channel_manager.klyuch_ne_dobavlen"),
};

export function providerColor(id: string): string {
  const palette = [
    "#4f46e5",
    "#0f766e",
    "#b45309",
    "#be123c",
    "#0369a1",
    "#7e22ce",
  ];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? "#4f46e5";
}

export function errorText(error: unknown): string {
  const value =
    error instanceof Error
      ? error.message
      : String(error || t("changes_panel.oshibka"));
  return value.replace(/^\d+\s+\w+\s+/, "");
}

export function providerStatusLabel(status: string): string {
  return PROVIDER_STATUS_LABELS[status] || status;
}

export function catalogErrorText(error: unknown, status?: string): string {
  const raw = errorText(error).trim();
  const lower = raw.toLowerCase();

  if (
    status === "unauthorized" ||
    /\b401\b|unauthori[sz]ed|invalid api.?key|authentication failed/.test(lower)
  ) {
    return t(
      "provider_channel_manager.api_klyuch_ne_prinyat_provayderom_proverte",
    );
  }
  if (
    /локальные и служебные адреса|локальную\/служебную сеть|ssrf|private address/.test(
      lower,
    )
  ) {
    return t(
      "provider_channel_manager.etot_base_url_zablokirovan_nastroykami_bezop",
    );
  }
  if (
    /terminated|fetch failed|econnreset|socket|network|aborted|timeout|timed out/.test(
      lower,
    )
  ) {
    return t(
      "provider_channel_manager.ne_udalos_zagruzit_spisok_modeley_soedinenie",
    );
  }
  if (/\b404\b|not found/.test(lower)) {
    return t("provider_channel_manager.provayder_ne_otdal_katalog_modeley_po");
  }
  if (/non-json|unexpected token|invalid json/.test(lower)) {
    return t(
      "provider_channel_manager.provayder_vernul_neozhidannyy_otvet_vmesto_k",
    );
  }
  return t(
    "provider_channel_manager.ne_udalos_zagruzit_spisok_modeley_proverte",
  );
}

export function draftFromChannel(channel: ProviderChannel): DraftChannel {
  return {
    id: channel.id,
    name: channel.name,
    protocol: channel.protocol,
    baseURL: channel.baseURL,
    enabled: channel.enabled,
    custom: channel.custom,
  };
}

export function filterProviderModels(
  models: ListedModel[],
  query: string,
): ListedModel[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) ||
      model.name.toLowerCase().includes(normalized),
  );
}
