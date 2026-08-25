import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import {
  type ProviderChannel,
  type ProviderProtocol,
  providerChannelsApi,
} from "@/api/providerChannels";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, tf } from "@/i18n";
import { cn } from "@/lib/utils";
import { useStore } from "@/store/useStore";
import { KeyIcon } from "../icons";
import { SettingsSection } from "./primitives";
import { ProviderChannelList } from "./provider-channels/ProviderChannelList";
import { ProviderModelsSection } from "./provider-channels/ProviderModelsSection";
import {
  API_FORMAT_LABELS,
  catalogErrorText,
  type DraftChannel,
  draftFromChannel,
  errorText,
  filterProviderModels,
  type ListedModel,
  type ManualRow,
  PROTOCOL_PLACEHOLDERS,
  type ProbeState,
  providerStatusLabel,
} from "./providerChannelModel";

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

  const selected =
    channels.find((channel) => channel.id === selectedId) ?? null;

  const showNotice = useCallback((message: string, isError = false) => {
    setNotice(message);
    setNoticeError(isError);
  }, []);

  const syncChannels = useCallback(
    async (preferId?: string | null) => {
      const response = await providerChannelsApi.list();
      setChannels(response.providers);
      const wanted = preferId ?? selectedId;
      const next =
        response.providers.find((item) => item.id === wanted)?.id ??
        response.providers[0]?.id ??
        null;
      setSelectedId(next);
      return response.providers;
    },
    [selectedId],
  );

  const loadChannelModels = useCallback(
    async (channel: ProviderChannel | null, force = false) => {
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
              tf(
                "provider_channel_manager.provayder_bolshe_ne_otdayot_eti_modeli",
                [result.missingManual.join(", ")],
              ),
              true,
            );
          }
        } else {
          const catalog = await api.listProviderCatalog();
          const rows = catalog.models
            .filter(
              (model) =>
                (model.sourceProviderID || model.providerID) === channel.id,
            )
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
    },
    [showNotice],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    providerChannelsApi
      .list()
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
    return () => {
      alive = false;
    };
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
  }, [
    selected?.id,
    selected?.baseURL,
    selected?.connected,
    selected?.enabled,
    loadChannelModels,
    selected,
  ]);

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

      const catalogReady =
        result.catalog.status === "live" || result.catalog.status === "cache";
      const providerDisabled = result.catalog.status === "disabled";
      const keyMissing =
        result.catalog.status === "unauthorized" && !result.catalog.error;
      showNotice(
        catalogReady
          ? tf(
              "provider_channel_manager.provayder_sohranen_naydeno_modeley_0",
              [result.catalog.count ?? 0],
            )
          : providerDisabled
            ? t("provider_channel_manager.provayder_sohranen_i_vyklyuchen")
            : keyMissing
              ? t(
                  "provider_channel_manager.provayder_sohranen_dobavte_api_key_chtoby",
                )
              : catalogErrorText(result.catalog.error, result.catalog.status),
        !catalogReady && !providerDisabled && !keyMissing,
      );

      const updated = await syncChannels(result.provider.id);
      const channel =
        updated.find((item) => item.id === result.provider.id) ??
        result.provider;
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
      description: t(
        "provider_channel_manager.klyuch_i_ego_ruchnye_modeli_tozhe",
      ),
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
      if (isHidden) next.delete(modelId);
      else next.add(modelId);
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
      const result = await providerChannelsApi.probeManualModel(
        selected.id,
        manualId.trim(),
      );
      setProbe(
        result.available
          ? { kind: "ok", latencyMs: result.latencyMs }
          : {
              kind: "fail",
              message:
                result.error ||
                t("provider_channel_manager.provayder_ne_podtverdil_etu_model"),
            },
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
      await Promise.all([
        loadModels(true),
        loadChannelModels(selected, selected.connected && selected.enabled),
      ]);
    } catch (error) {
      showNotice(errorText(error), true);
    } finally {
      setSaving(false);
    }
  };

  /** Флаги уже проверенной модели меняются без повторного вызова провайдера. */
  const updateManual = async (
    model: ManualRow,
    patch: { enabled?: boolean; isFree?: boolean },
  ) => {
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

  const toggleManualEnabled = (model: ManualRow) =>
    updateManual(model, { enabled: !model.enabled });

  const toggleManualFree = (model: ManualRow) =>
    updateManual(model, { isFree: !model.is_free });

  const removeManual = async (modelId: string) => {
    if (!selected) return;
    try {
      await providerChannelsApi.deleteManualModel(selected.id, modelId);
      await Promise.all([
        loadModels(true),
        loadChannelModels(selected, selected.connected && selected.enabled),
      ]);
    } catch (error) {
      showNotice(errorText(error), true);
    }
  };

  const visibleModels = useMemo(
    () => filterProviderModels(models, modelQuery),
    [modelQuery, models],
  );

  const editedChannel = draft?.id
    ? (channels.find((item) => item.id === draft.id) ?? null)
    : null;
  const isConnected = editedChannel?.connected ?? false;

  return (
    <SettingsSection
      title={t("provider_channel_manager.provaydery_modeley")}
      description={t(
        "provider_channel_manager.snachala_podklyuchite_provaydera_odin_raz_z",
      )}
    >
      <div className="grid min-h-[520px] overflow-hidden rounded-2xl border border-border bg-card md:grid-cols-[230px_minmax(0,1fr)]">
        <ProviderChannelList
          channels={channels}
          selectedId={selectedId}
          loading={loading}
          onAdd={startNew}
          onSelect={setSelectedId}
        />

        <div className="min-w-0 p-4 md:p-5">
          {!draft ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("provider_channel_manager.vyberite_ili_dobavte_provaydera")}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold">
                      {draft.id
                        ? draft.name
                        : t("provider_channel_manager.novyy_provayder")}
                    </h3>
                    {isConnected && (
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        {t("provider_channel_manager.podklyuchen")}
                      </span>
                    )}
                    {status && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {providerStatusLabel(status)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {draft.custom
                      ? t("provider_channel_manager.polzovatelskiy_kanal")
                      : t("provider_channel_manager.vstroennyy_provayder")}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) =>
                      setDraft({ ...draft, enabled: event.target.checked })
                    }
                  />
                  Включён
                </label>
              </div>

              {notice && (
                <div
                  className={cn(
                    "rounded-xl px-3 py-2 text-xs",
                    noticeError
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted/60 text-foreground",
                  )}
                >
                  {notice}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5" htmlFor="provider-name">
                  <span className="text-xs font-medium">
                    {t("provider_channel_manager.nazvanie")}
                  </span>
                  <Input
                    id="provider-name"
                    className="h-9"
                    value={draft.name}
                    disabled={!draft.custom && Boolean(draft.id)}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                    placeholder={t(
                      "provider_channel_manager.naprimer_moonshot",
                    )}
                  />
                </label>
                <label className="space-y-1.5" htmlFor="provider-protocol">
                  <span className="text-xs font-medium">API format</span>
                  <select
                    id="provider-protocol"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={draft.protocol}
                    disabled={!draft.custom && Boolean(draft.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        protocol: event.target.value as ProviderProtocol,
                      })
                    }
                  >
                    <option value="openai">{API_FORMAT_LABELS.openai}</option>
                    <option value="anthropic">
                      {API_FORMAT_LABELS.anthropic}
                    </option>
                    <option value="google">{API_FORMAT_LABELS.google}</option>
                  </select>
                  <span className="block text-[10px] leading-relaxed text-muted-foreground">
                    Это формат запросов, а не бренд провайдера. Выберите вариант
                    по endpoint из документации; Z Agent сам добавит служебный
                    путь к Base URL.
                  </span>
                </label>
              </div>

              <label className="block space-y-1.5" htmlFor="provider-base-url">
                <span className="text-xs font-medium">API Base URL</span>
                <Input
                  id="provider-base-url"
                  className="h-9 font-mono text-xs"
                  value={draft.baseURL}
                  onChange={(event) =>
                    setDraft({ ...draft, baseURL: event.target.value })
                  }
                  placeholder={PROTOCOL_PLACEHOLDERS[draft.protocol]}
                />
                <span className="block text-[10px] text-muted-foreground">
                  Можно указать обычный endpoint провайдера или совместимый
                  relay endpoint. Для пользовательских URL runtime применяет
                  SSRF-проверку до обращения к relay.
                </span>
              </label>

              <label className="block space-y-1.5" htmlFor="provider-api-key">
                <span className="text-xs font-medium">API Key</span>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                      <KeyIcon size={13} />
                    </span>
                    <Input
                      id="provider-api-key"
                      type="password"
                      className="h-9 pl-8"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={
                        isConnected
                          ? t(
                              "provider_channel_manager.ostavte_pustym_chtoby_sohranit_tekusch",
                            )
                          : t("provider_channel_manager.vstavte_api_key")
                      }
                    />
                  </div>
                  {isConnected && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void disconnect()}
                    >
                      {t("provider_channel_manager.otklyuchit_klyuch")}
                    </Button>
                  )}
                </div>
              </label>

              <div className="flex flex-wrap items-center gap-2 border-b border-border pb-5">
                <Button
                  size="sm"
                  disabled={
                    saving || !draft.name.trim() || !draft.baseURL.trim()
                  }
                  onClick={() => void save()}
                >
                  {saving
                    ? t("provider_channel_manager.sohranyaem")
                    : draft.id
                      ? t("file_editor.sohranit")
                      : t("provider_channel_manager.dobavit_i_zagruzit_modeli")}
                </Button>
                {draft.id && draft.custom && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => void removeProvider()}
                  >
                    {t("provider_channel_manager.udalit_provaydera")}
                  </Button>
                )}
              </div>

              {draft.id && selected && (
                <ProviderModelsSection
                  channel={selected}
                  models={models}
                  visibleModels={visibleModels}
                  manualModels={manual}
                  hiddenModels={hidden}
                  query={modelQuery}
                  status={status}
                  refreshing={refreshing}
                  saving={saving}
                  manualId={manualId}
                  manualName={manualName}
                  manualFree={manualFree}
                  manualBusy={manualBusy}
                  probe={probe}
                  onQueryChange={setModelQuery}
                  onRefresh={() => void refreshModels()}
                  onToggleModel={(modelId) => void toggleModel(modelId)}
                  onManualIdChange={(value) => {
                    setManualId(value);
                    setProbe({ kind: "idle" });
                  }}
                  onManualNameChange={setManualName}
                  onManualFreeChange={setManualFree}
                  onProbe={() => void probeManual()}
                  onAddManual={() => void addManual()}
                  onToggleManualEnabled={(model) =>
                    void toggleManualEnabled(model)
                  }
                  onToggleManualFree={(model) => void toggleManualFree(model)}
                  onRemoveManual={(modelId) => void removeManual(modelId)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
