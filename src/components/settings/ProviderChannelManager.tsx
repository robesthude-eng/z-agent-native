import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import {
  providerChannelsApi,
  type ProviderChannel,
  type ProviderProtocol,
} from "@/api/providerChannels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useStore } from "@/store/useStore";
import { CheckIcon, CloseIcon, KeyIcon, SearchIcon } from "../icons";
import { SettingsSection } from "./primitives";

type DraftChannel = {
  id?: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  custom: boolean;
};

type ListedModel = { id: string; name: string };

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
  live: "каталог доступен",
  cache: "каталог из кэша",
  unavailable: "каталог недоступен",
  unauthorized: "нет доступа к каталогу",
  disabled: "выключен",
};

function providerColor(id: string) {
  const palette = ["#4f46e5", "#0f766e", "#b45309", "#be123c", "#0369a1", "#7e22ce"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function errorText(error: unknown) {
  const value = error instanceof Error ? error.message : String(error || "Ошибка");
  return value.replace(/^\d+\s+\w+\s+/, "");
}

function providerStatusLabel(status: string) {
  return PROVIDER_STATUS_LABELS[status] || status;
}

function catalogErrorText(error: unknown, status?: string) {
  const raw = errorText(error).trim();
  const lower = raw.toLowerCase();

  if (status === "unauthorized" || /\b401\b|unauthori[sz]ed|invalid api.?key|authentication failed/.test(lower)) {
    return "API-ключ не принят провайдером. Проверьте ключ и доступ к API.";
  }
  if (/локальные и служебные адреса|локальную\/служебную сеть|ssrf|private address/.test(lower)) {
    return "Этот Base URL заблокирован настройками безопасности. Используйте публичный API endpoint провайдера.";
  }
  if (/terminated|fetch failed|econnreset|socket|network|aborted|timeout|timed out/.test(lower)) {
    return "Не удалось загрузить список моделей: соединение с провайдером было прервано. Повторите попытку.";
  }
  if (/\b404\b|not found/.test(lower)) {
    return "Провайдер не отдал каталог моделей по этому Base URL. Проверьте Base URL или добавьте Model ID вручную.";
  }
  if (/non-json|unexpected token|invalid json/.test(lower)) {
    return "Провайдер вернул неожиданный ответ вместо каталога моделей.";
  }
  return "Не удалось загрузить список моделей. Проверьте Base URL, API-ключ и доступность каталога моделей.";
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
        api.listHiddenModels(channel.id),
      ]);
      setManual(manualResponse.models ?? []);
      setHidden(new Set(hiddenResponse.hidden ?? []));
      if (!channel.connected || !channel.enabled) {
        setModels([]);
        setStatus(channel.enabled ? "unauthorized" : "disabled");
        return;
      }
      if (force) {
        const result = await providerChannelsApi.refresh(channel.id);
        setModels(result.models ?? []);
        setStatus(result.status);
        if (result.error && (result.models?.length ?? 0) === 0) {
          showNotice(catalogErrorText(result.error, result.status), true);
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
          ? `Провайдер сохранён. Найдено моделей: ${result.catalog.count ?? 0}.`
          : providerDisabled
            ? "Провайдер сохранён и выключен."
            : keyMissing
              ? "Провайдер сохранён. Добавьте API key, чтобы загрузить модели."
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
      showNotice("API-ключ отключён.");
      await loadChannelModels(channel, false);
    } catch (error) {
      showNotice(errorText(error), true);
    }
  };

  const removeProvider = async () => {
    if (!draft?.id || !draft.custom) return;
    if (!window.confirm(`Удалить провайдера ${draft.name}? Ключ и его ручные модели тоже будут удалены.`)) return;
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

  const resetBuiltin = async () => {
    if (!draft?.id || draft.custom) return;
    try {
      await providerChannelsApi.resetBuiltin(draft.id);
      const updated = await syncChannels(draft.id);
      const channel = updated.find((item) => item.id === draft.id) ?? null;
      if (channel) {
        setDraft(draftFromChannel(channel));
        await loadChannelModels(channel, true);
      }
      showNotice("Endpoint и параметры встроенного провайдера сброшены.");
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
      await api.setModelHidden(selected.id, modelId, !isHidden);
      await loadModels(true);
    } catch (error) {
      showNotice(errorText(error), true);
      await loadChannelModels(selected, true);
    }
  };

  const addManual = async () => {
    if (!selected || !manualId.trim()) return;
    setSaving(true);
    try {
      await providerChannelsApi.addManualModel(selected.id, manualId.trim(), manualName.trim() || undefined);
      setManualId("");
      setManualName("");
      showNotice("Модель проверена и добавлена.");
      await Promise.all([loadModels(true), loadChannelModels(selected, selected.connected && selected.enabled)]);
    } catch (error) {
      showNotice(errorText(error), true);
    } finally {
      setSaving(false);
    }
  };

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
      title="Провайдеры моделей"
      description="Сначала подключите провайдера один раз — Z Agent сам загрузит его модели. Если endpoint не умеет отдавать список моделей, нужный Model ID можно добавить вручную."
    >
      <div className="grid min-h-[520px] overflow-hidden rounded-2xl border border-border bg-card md:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-b border-border bg-muted/20 md:border-b-0 md:border-r">
          <div className="border-b border-border p-3">
            <Button className="w-full" size="sm" onClick={startNew}>+ Добавить провайдера</Button>
          </div>
          <div className="max-h-56 overflow-y-auto p-2 md:max-h-none md:flex-1">
            {loading ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">Загрузка…</div>
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
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Выберите или добавьте провайдера.</div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold">{draft.id ? draft.name : "Новый провайдер"}</h3>
                    {isConnected && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700">подключён</span>}
                    {status && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{providerStatusLabel(status)}</span>}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {draft.custom ? "Пользовательский канал" : "Встроенный провайдер"}
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
                  <span className="text-xs font-medium">Название</span>
                  <Input
                    className="h-9"
                    value={draft.name}
                    disabled={!draft.custom && Boolean(draft.id)}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="Например Moonshot"
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
                      placeholder={isConnected ? "Оставьте пустым, чтобы сохранить текущий ключ" : "Вставьте API key"}
                    />
                  </div>
                  {isConnected && <Button size="sm" variant="outline" onClick={() => void disconnect()}>Отключить ключ</Button>}
                </div>
              </label>

              <div className="flex flex-wrap items-center gap-2 border-b border-border pb-5">
                <Button size="sm" disabled={saving || !draft.name.trim() || !draft.baseURL.trim()} onClick={() => void save()}>
                  {saving ? "Сохраняем…" : draft.id ? "Сохранить" : "Добавить и загрузить модели"}
                </Button>
                {draft.id && !draft.custom && editedChannel?.overridden && (
                  <Button size="sm" variant="ghost" onClick={() => void resetBuiltin()}>Сбросить endpoint</Button>
                )}
                {draft.id && draft.custom && (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void removeProvider()}>Удалить провайдера</Button>
                )}
              </div>

              {draft.id && selected && (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">Модели</div>
                      <div className="text-[11px] text-muted-foreground">
                        {models.length} из API · {manual.length} добавлено вручную
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={!selected.connected || refreshing} onClick={() => void refreshModels()}>
                      {refreshing ? "Загружаем…" : "Обновить модели"}
                    </Button>
                  </div>

                  {models.length > 0 && (
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><SearchIcon size={13} /></span>
                      <Input className="h-8 pl-8 text-xs" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Поиск модели" />
                    </div>
                  )}

                  <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
                    {visibleModels.length === 0 ? (
                      <div className="px-3 py-5 text-xs text-muted-foreground">
                        {!selected.connected
                          ? "Сохраните API key, чтобы автоматически получить модели."
                          : status === "unavailable"
                            ? "Каталог моделей сейчас недоступен. Повторите загрузку или добавьте Model ID вручную."
                            : status === "unauthorized"
                              ? "API-ключ не даёт доступ к каталогу моделей. Проверьте ключ."
                              : "Endpoint не вернул список моделей. Добавьте Model ID вручную ниже."}
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
                    <div className="mb-2 text-xs font-medium">Добавить Model ID вручную</div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
                      <Input className="h-8 font-mono text-xs" value={manualId} onChange={(event) => setManualId(event.target.value)} placeholder="model-id" />
                      <Input className="h-8 text-xs" value={manualName} onChange={(event) => setManualName(event.target.value)} placeholder="Название (необязательно)" />
                      <Button size="sm" variant="outline" disabled={!manualId.trim() || saving || !selected.connected} onClick={() => void addManual()}>Добавить</Button>
                    </div>
                    {manual.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {manual.map((model) => (
                          <div key={model.model_id} className="flex items-center gap-2 rounded-lg bg-muted/35 px-2.5 py-1.5">
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{model.model_id}</span>
                            <button type="button" className="rounded p-1 text-muted-foreground hover:text-destructive" onClick={() => void removeManual(model.model_id)} aria-label={`Удалить ${model.model_id}`}>
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
