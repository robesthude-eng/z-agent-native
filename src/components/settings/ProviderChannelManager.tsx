import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import {
  providerChannelsApi,
  type ProviderChannel,
  type ProviderProtocol,
} from "@/api/providerChannels";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useStore } from "@/store/useStore";
import { CheckIcon, CloseIcon, KeyIcon, SearchIcon } from "../icons";
import { SettingsSection } from "./primitives";
import { t, tf } from "@/i18n";

type DraftChannel = {
  id?: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  custom: boolean;
};

type ListedModel = { id: string; name: string };

type ProbeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; latencyMs: number }
  | { kind: "fail"; message: string };

type ManualRow = {
  model_id: string;
  name: string | null;
  enabled: boolean;
  is_free: boolean;
};

const API_FORMAT_LABELS: Record<ProviderProtocol, string> = {
  openai: "Chat Completions (/chat/completions)",
  anthropic: "Messages (/messages)",
  google: "Generate Content (:generateContent)",
};

const PROTOCOL_PLACEHOLDERS: Record<ProviderProtocol, string> = {
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

function providerColor(id: string) {
  const palette = ["#4f46e5", "#0f766e", "#b45309", "#be123c", "#0369a1", "#7e22ce"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function errorText(error: unknown) {
  const value = error instanceof Error ? error.message : String(error || t("changes_panel.oshibka"));
  return value.replace(/^\d+\s+\w+\s+/, "");
}

function providerStatusLabel(status: string) {
  return PROVIDER_STATUS_LABELS[status] || status;
}

function catalogErrorText(error: unknown, status?: string) {
  const raw = errorText(error).trim();
  const lower = raw.toLowerCase();

  if (status === "unauthorized" || /\b401\b|unauthori[sz]ed|invalid api.?key|authentication failed/.test(lower)) {
    return t("provider_channel_manager.api_klyuch_ne_prinyat_provayderom_proverte");
  }
  if (/локальные и служебные адреса|локальную\/служебную сеть|ssrf|private address/.test(lower)) {
    return t("provider_channel_manager.etot_base_url_zablokirovan_nastroykami_bezop");
  }
  if (/terminated|fetch failed|econnreset|socket|network|aborted|timeout|timed out/.test(lower)) {
    return t("provider_channel_manager.ne_udalos_zagruzit_spisok_modeley_soedinenie");
  }
  if (/\b404\b|not found/.test(lower)) {
    return t("provider_channel_manager.provayder_ne_otdal_katalog_modeley_po");
  }
  if (/non-json|unexpected token|invalid json/.test(lower)) {
    return t("provider_channel_manager.provayder_vernul_neozhidannyy_otvet_vmesto_k");
  }
  return t("provider_channel_manager.ne_udalos_zagruzit_spisok_modeley_proverte");
}

function draftFromChannel(channel: ProviderChannel): DraftChannel {
  return {
    id: channel.id,
    name: channel.name,
    protocol: channel.protocol,
    baseURL: channel.baseURL,
    enabled: channel.enabled,
    custom: channel.custom,
  };
}

export function ProviderChannelManager() {
  const askConfirm = useConfirm();
  const loadModels = useStore((s) => s.loadModels);
  const loadAuth = useStore((s) => s.loadAuth);

  const [channels, setChannels] = useState<ProviderChannel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftChannel | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ListedModel[]>([]);
  const [manual, setManual] = useState<ManualRow[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [modelQuery, setModelQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualFree, setManualFree] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const selected = channels.find((channel) => channel.id === selectedId) ?? null;

  const showNotice = useCallback((message: string, isError = false) => {
    setNotice(message);
    setNoticeError(isError);
  }, []);

  const syncChannels = useCallback(async (preferId?: string | null) => {
    const response = await providerChannelsApi.list();
    setChannels(response.providers);
    const wanted = preferId ?? selectedId;
    const next = response.providers.find((item) => item.id === wanted)?.id ?? response.providers[0]?.id ?? null;
    setSelectedId(next);
    return response.providers;
  }, [selectedId]);

  const loadChannelModels = useCallback(async (channel: ProviderChannel | null, force = false) => {
    if (!channel) {
      setModels([]);
      setManual([]);
      setHidden(new Set());
      setStatus(null);
      return;
    }
    setRefreshing(true);
    try {
      const [manualResponse, hiddenResponse] = await Promise.all([
        providerChannelsApi.listManualModels(channel.id),
        providerChannelsApi.listHiddenModels(channel.id),
      ]);
      setManual(manualResponse.models ?? []);
      setHidden(new Set(hiddenResponse.hidden ?? []));
      if (!channel.connected || !channel.enabled) {
        setModels([]);
        // «Ключ не добавлен» и «провайдер не пустил с этим ключом» — разные
        // состояния, хотя раньше оба показывались как «нет доступа к каталогу».
        setStatus(!channel.enabled ? "disabled" : "nokey");
        return;
      }
      if (force) {
        const result = await providerChannelsApi.refresh(channel.id);
        // Живой ответ замещает список целиком, даже если он стал короче.
        setModels(result.models ?? []);
        setStatus(result.status);
        // Ошибка показывается всегда, а не только при пустом списке:
        // иначе «Обновить» молча оставляло прежний набор и выглядело как успех.
        if (result.error) {
          showNotice(catalogErrorText(result.error, result.status), true);
        } else if (result.missingManual?.length) {
          showNotice(
            tf("provider_channel_manager.provayder_bolshe_ne_otdayot_eti_modeli", [
              result.missingManual.join(", "),
            ]),
            true,
          );
        }
      } else {
        const catalog = await api.listProviderCatalog();
        const rows = catalog.models
          .filter((model) => (model.sourceProviderID || model.providerID) === channel.id)
          .map((model) => ({ id: model.modelID, name: model.modelName }));
        const unique = new Map(rows.map((model) => [model.id, model]));
        setModels([...unique.values()]);
        setStatus(catalog.providers?.[channel.id]?.status ?? null);
      }
    } catch (error) {
      setModels([]);
      showNotice(errorText(error), true);
    } finally {
      setRefreshing(false);
    }
  }, [showNotice]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    providerChannelsApi.list()
      .then((response) => {
        if (!alive) return;
        setChannels(response.providers);
        setSelectedId(response.providers[0]?.id ?? null);
      })
      .catch((error) => {
        if (alive) showNotice(errorText(error), true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [showNotice]);

  useEffect(() => {
    if (!selected) return;
    setDraft(draftFromChannel(selected));
    setApiKey("");
    setNotice(null);
    setModelQuery("");
    setManualId("");
    setManualName("");
    setManualFree(false);
    setProbe({ kind: "idle" });
    // Fetch the raw provider catalog here, rather than the filtered global
    // catalog, so hidden models remain visible and can be re-enabled.
    void loadChannelModels(selected, selected.connected && selected.enabled);
  }, [selected?.id, selected?.baseURL, selected?.connected, selected?.enabled, loadChannelModels, selected]);

  const startNew = () => {
    setSelectedId(null);
    setDraft({
      name: "",
      protocol: "openai",
      baseURL: "",
      enabled: true,
      custom: true,
    });
    setApiKey("");
    setModels([]);
    setManual([]);
    setHidden(new Set());
    setStatus(null);
    setNotice(null);
  };

  const save = async () => {
    if (!draft?.name.trim() || !draft.baseURL.trim()) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await providerChannelsApi.save({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        protocol: draft.protocol,
        baseURL: draft.baseURL.trim(),
        enabled: draft.enabled,
        ...(apiKey.trim() ? { key: apiKey.trim() } : {}),
      });
      setApiKey("");
      setStatus(result.catalog.status);

      const catalogReady = result.catalog.status === "live" || result.catalog.status === "cache";
      const providerDisabled = result.catalog.status === "disabled";
      const keyMissing = result.catalog.status === "unauthorized" && !result.catalog.error;
      showNotice(
        catalogReady
          ? tf("provider_channel_manager.provayder_sohranen_naydeno_modeley_0", [result.catalog.count ?? 0])
          : providerDisabled
            ? t("provider_channel_manager.provayder_sohranen_i_vyklyuchen")
            : keyMissing
              ? t("provider_channel_manager.provayder_sohranen_dobavte_api_key_chtoby")
              : catalogErrorText(result.catalog.error, result.catalog.status),
        !catalogReady && !providerDisabled && !keyMissing,
      );

      const updated = await syncChannels(result.provider.id);
      const channel = updated.find((item) => item.id === result.provider.id) ?? result.provider;
      setSelectedId(channel.id);
      setDraft(draftFromChannel(channel));
      await Promise.all([loadAuth(), loadModels(true)]);
      await loadChannelModels(channel, true);
    } catch (error) {
      showNotice(errorText(error), true);
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!draft?.id) return;
    try {
      await providerChannelsApi.removeKey(draft.id);
      await Promise.all([loadAuth(), loadModels(true)]);
      const updated = await syncChannels(draft.id);
      const channel = updated.find((item) => item.id === draft.id) ?? null;
      showNotice(t("provider_channel_manager.api_klyuch_otklyuchen"));
      await loadChannelModels(channel, false);
    } catch (error) {
      showNotice(errorText(error), true);
    }
  };

  const removeProvider = async () => {
    if (!draft?.id || !draft.custom) return;
    const ok = await askConfirm({
      title: tf("provider_channel_manager.udalit_provaydera_0", [draft.name]),
      description: t("provider_channel_manager.klyuch_i_ego_ruchnye_modeli_tozhe"),
      confirmLabel: t("workspace.udalit"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await providerChannelsApi.remove(draft.id);
      await Promise.all([loadAuth(), loadModels(true)]);
      setDraft(null);
      setSelectedId(null);
      const next = await syncChannels(null);
      setSelectedId(next[0]?.id ?? null);
    } catch (error) {
      showNotice(errorText(error), true);
    }
  };

  const refreshModels = async () => {
    if (!selected) return;
    setNotice(null);
    await loadChannelModels(selected, true);
    await loadModels(true);
  };

  const toggleModel = async (modelId: string) => {
    if (!selected) return;
    const isHidden = hidden.has(modelId);
    setHidden((current) => {
      const next = new Set(current);
      if (isHidden) next.delete(modelId); else next.add(modelId);
      return next;
    });
    try {
      await providerChannelsApi.setModelHidden(selected.id, modelId, !isHidden);
      await loadModels(true);
    } catch (error) {
      showNotice(errorText(error), true);
      await loadChannelModels(selected, true);
    }
  };

  /** Проверка без сохранения: видно, жива ли модель, до добавления в список. */
  const probeManual = async () => {
    if (!selected || !manualId.trim()) return;
    setProbe({ kind: "checking" });
    try {
      const result = await providerChannelsApi.probeManualModel(selected.id, manualId.trim());
      setProbe(
        result.available
          ? { kind: "ok", latencyMs: result.latencyMs }
          : { kind: "fail", message: result.error || t("provider_channel_manager.provayder_ne_podtverdil_etu_model") },
      );
    } catch (error) {
      setProbe({ kind: "fail", message: errorText(error) });
    }
  };

  const addManual = async () => {
    if (!selected || !manualId.trim()) return;
    setSaving(true);
    try {
      await providerChannelsApi.addManualModel(selected.id, {
        modelId: manualId.trim(),
        name: manualName.trim() || null,
        isFree: manualFree,
      });
      setManualId("");
      setManualName("");
      setManualFree(false);
      setProbe({ kind: "idle" });
      showNotice(t("provider_channel_manager.model_proverena_i_dobavlena"));
      await Promise.all([loadModels(true), loadChannelModels(selected, selected.connected && selected.enabled)]);
    } catch (error) {
      showNotice(errorText(error), true);
    } finally {
      setSaving(false);
    }
  };

  /** Флаги уже проверенной модели меняются без повторного вызова провайдера. */
  const updateManual = async (model: ManualRow, patch: { enabled?: boolean; isFree?: boolean }) => {
    if (!selected) return;
    setManualBusy(model.model_id);
    try {
      await providerChannelsApi.addManualModel(selected.id, {
        modelId: model.model_id,
        probe: false,
        ...patch,
      });
      await Promise.all([loadModels(true), loadChannelModels(selected, false)]);
    } catch (error) {
      showNotice(errorText(error), true);
    } finally {
      setManualBusy(null);
    }
  };

  const toggleManualEnabled = (model: ManualRow) => updateManual(model, { enabled: !model.enabled });

  const toggleManualFree = (model: ManualRow) => updateManual(model, { isFree: !model.is_free });

  const removeManual = async (modelId: string) => {
    if (!selected) return;
    try {
      await providerChannelsApi.deleteManualModel(selected.id, modelId);
      await Promise.all([loadModels(true), loadChannelModels(selected, selected.connected && selected.enabled)]);
    } catch (error) {
      showNotice(errorText(error), true);
    }
  };

  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return models.filter((model) => !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));
  }, [modelQuery, models]);

  const editedChannel = draft?.id ? channels.find((item) => item.id === draft.id) ?? null : null;
  const isConnected = editedChannel?.connected ?? false;

  return (
    <SettingsSection
      title={t("provider_channel_manager.provaydery_modeley")}
      description={t("provider_channel_manager.snachala_podklyuchite_provaydera_odin_raz_z")}
    >
      <div className="grid min-h-[520px] overflow-hidden rounded-2xl border border-border bg-card md:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-b border-border bg-muted/20 md:border-b-0 md:border-r">
          <div className="border-b border-border p-3">
            <Button className="w-full" size="sm" onClick={startNew}>{t("provider_channel_manager.dobavit_provaydera")}</Button>
          </div>
          <div className="max-h-56 overflow-y-auto p-2 md:max-h-none md:flex-1">
            {loading ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">{t("provider_channel_manager.zagruzka")}</div>
            ) : channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                onClick={() => setSelectedId(channel.id)}
                className={cn(
                  "mb-1 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                  selectedId === channel.id ? "bg-background shadow-sm" : "hover:bg-muted/70",
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: providerColor(channel.id) }}>
                  {channel.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                    {channel.name}
                    {channel.connected && <CheckIcon size={12} />}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {API_FORMAT_LABELS[channel.protocol]}
                  </span>
                </span>
                {!channel.enabled && <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />}
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0 p-4 md:p-5">
          {!draft ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("provider_channel_manager.vyberite_ili_dobavte_provaydera")}</div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold">{draft.id ? draft.name : t("provider_channel_manager.novyy_provayder")}</h3>
                    {isConnected && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700">{t("provider_channel_manager.podklyuchen")}</span>}
                    {status && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{providerStatusLabel(status)}</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {draft.custom ? t("provider_channel_manager.polzovatelskiy_kanal") : t("provider_channel_manager.vstroennyy_provayder")}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                  Включён
                </label>
              </div>

              {notice && (
                <div className={cn("rounded-xl px-3 py-2 text-xs", noticeError ? "bg-destructive/10 text-destructive" : "bg-muted/60 text-foreground")}>
                  {notice}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium">{t("provider_channel_manager.nazvanie")}</span>
                  <Input
                    className="h-9"
                    value={draft.name}
                    disabled={!draft.custom && Boolean(draft.id)}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder={t("provider_channel_manager.naprimer_moonshot")}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium">API format</span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={draft.protocol}
                    disabled={!draft.custom && Boolean(draft.id)}
                    onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProviderProtocol })}
                  >
                    <option value="openai">{API_FORMAT_LABELS.openai}</option>
                    <option value="anthropic">{API_FORMAT_LABELS.anthropic}</option>
                    <option value="google">{API_FORMAT_LABELS.google}</option>
                  </select>
                  <span className="block text-[10px] leading-relaxed text-muted-foreground">
                    Это формат запросов, а не бренд провайдера. Выберите вариант по endpoint из документации; Z Agent сам добавит служебный путь к Base URL.
                  </span>
                </label>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium">API Base URL</span>
                <Input
                  className="h-9 font-mono text-xs"
                  value={draft.baseURL}
                  onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })}
                  placeholder={PROTOCOL_PLACEHOLDERS[draft.protocol]}
                />
                <span className="block text-[10px] text-muted-foreground">
                  Можно указать обычный endpoint провайдера или совместимый relay endpoint. Для пользовательских URL runtime применяет SSRF-проверку до обращения к relay.
                </span>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium">API Key</span>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><KeyIcon size={13} /></span>
                    <Input
                      type="password"
                      className="h-9 pl-8"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={isConnected ? t("provider_channel_manager.ostavte_pustym_chtoby_sohranit_tekusch") : t("provider_channel_manager.vstavte_api_key")}
                    />
                  </div>
                  {isConnected && <Button size="sm" variant="outline" onClick={() => void disconnect()}>{t("provider_channel_manager.otklyuchit_klyuch")}</Button>}
                </div>
              </label>

              <div className="flex flex-wrap items-center gap-2 border-b border-border pb-5">
                <Button size="sm" disabled={saving || !draft.name.trim() || !draft.baseURL.trim()} onClick={() => void save()}>
                  {saving ? t("provider_channel_manager.sohranyaem") : draft.id ? t("file_editor.sohranit") : t("provider_channel_manager.dobavit_i_zagruzit_modeli")}
                </Button>
                {draft.id && draft.custom && (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void removeProvider()}>{t("provider_channel_manager.udalit_provaydera")}</Button>
                )}
              </div>

              {draft.id && selected && (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{t("settings_panel.modeli")}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {models.length} из API · {manual.length} добавлено вручную
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={!selected.connected || !selected.enabled || refreshing} onClick={() => void refreshModels()}>
                      {refreshing ? t("provider_channel_manager.zagruzhaem") : t("provider_channel_manager.obnovit_modeli")}
                    </Button>
                  </div>

                  {models.length > 0 && (
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><SearchIcon size={13} /></span>
                      <Input className="h-8 pl-8 text-xs" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t("provider_channel_manager.poisk_modeli")} />
                    </div>
                  )}

                  <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
                    {visibleModels.length === 0 ? (
                      <div className="px-3 py-5 text-xs text-muted-foreground">
                        {!selected.enabled
                          ? t("provider_channel_manager.kanal_vyklyuchen_vklyuchite_ego_chtoby_zagru")
                          : !selected.connected
                            ? t("provider_channel_manager.sohranite_api_key_chtoby_avtomaticheski_polu")
                            : status === "unavailable"
                              ? t("provider_channel_manager.katalog_modeley_seychas_nedostupen_povtorite")
                              : status === "unauthorized"
                                ? t("provider_channel_manager.api_klyuch_ne_daet_dostup_k")
                                : t("provider_channel_manager.endpoint_ne_vernul_spisok_modeley_dobavte")}
                      </div>
                    ) : visibleModels.map((model) => (
                      <label key={model.id} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted/30">
                        <input type="checkbox" checked={!hidden.has(model.id)} onChange={() => void toggleModel(model.id)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{model.name || model.id}</span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">{model.id}</span>
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="rounded-xl border border-dashed border-border p-3">
                    <div className="mb-2 text-xs font-medium">{t("provider_channel_manager.dobavit_model_id_vruchnuyu")}</div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                      <Input
                        className="h-8 font-mono text-xs"
                        value={manualId}
                        onChange={(event) => { setManualId(event.target.value); setProbe({ kind: "idle" }); }}
                        placeholder="model-id"
                      />
                      <Input className="h-8 text-xs" value={manualName} onChange={(event) => setManualName(event.target.value)} placeholder={t("provider_channel_manager.nazvanie_neobyazatelno")} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input type="checkbox" checked={manualFree} onChange={(event) => setManualFree(event.target.checked)} />
                        Бесплатная
                      </label>
                      <span className="flex-1" />
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!manualId.trim() || probe.kind === "checking" || !selected.connected || !selected.enabled}
                        onClick={() => void probeManual()}
                      >
                        {probe.kind === "checking" ? t("provider_channel_manager.proveryaem") : t("provider_channel_manager.proverit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!manualId.trim() || saving || !selected.connected || !selected.enabled}
                        onClick={() => void addManual()}
                      >
                        Добавить
                      </Button>
                    </div>
                    {(probe.kind === "ok" || probe.kind === "fail") && (
                      <div className={cn("mt-2 text-[11px]", probe.kind === "ok" ? "text-emerald-700" : "text-destructive")}>
                        {probe.kind === "ok"
                          ? tf("provider_channel_manager.model_otvetila_za_0_ms_mozhno", [probe.latencyMs])
                          : probe.message}
                      </div>
                    )}
                    {manual.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {manual.map((model) => (
                          <div key={model.model_id} className="flex items-center gap-2 rounded-lg bg-muted/35 px-2.5 py-1.5">
                            <input
                              type="checkbox"
                              checked={model.enabled}
                              disabled={manualBusy === model.model_id}
                              onChange={() => void toggleManualEnabled(model)}
                              aria-label={tf("provider_channel_manager.pokazyvat_0_v_spiske_modeley", [model.model_id])}
                            />
                            <span className="min-w-0 flex-1">
                              <span className={cn("block truncate font-mono text-[11px]", !model.enabled && "text-muted-foreground line-through")}>
                                {model.model_id}
                              </span>
                              {model.name && <span className="block truncate text-[10px] text-muted-foreground">{model.name}</span>}
                            </span>
                            <button
                              type="button"
                              disabled={manualBusy === model.model_id}
                              aria-pressed={model.is_free}
                              onClick={() => void toggleManualFree(model)}
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                                model.is_free ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground hover:text-foreground",
                              )}
                              title={model.is_free ? t("provider_channel_manager.otmetka_besplatnaya_vklyuchena") : t("provider_channel_manager.otmetit_kak_besplatnuyu")}
                            >
                              FREE
                            </button>
                            <button type="button" className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => void removeManual(model.model_id)} aria-label={tf("provider_channel_manager.udalit_0", [model.model_id])}>
                              <CloseIcon size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
