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

const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic-compatible",
  google: "Google Gemini",
};

const PROTOCOL_PLACEHOLDERS: Record<ProviderProtocol, string> = {
  openai: "https://api.example.com/v1",
  anthropic: "https://api.example.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
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

  const showNotice = (message: string, isError = false) => {
    setNotice(message);
    setNoticeError(isError);
  };

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
        if (result.error && (result.models?.length ?? 0) === 0) showNotice(result.error, true);
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
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    providerChannelsApi.list()
      .then((response) => {
        if (!alive) return;
        setChannels(response.providers);
        setSelectedId(response.providers[0]?.id ?? null);
      })
      .catch((error) => alive && showNotice(errorText(error), true))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selected || draft?.id === undefined && draft) return;
    setDraft({
      id: selected.id,
      name: selected.name,
      protocol: selected.protocol,
      baseURL: selected.baseURL,
      enabled: selected.enabled,
      custom: selected.custom,
    });
    setApiKey("");
    setNotice(null);
    setModelQuery("");
    setManualId("");
    setManualName("");
    void loadChannelModels(selected, false);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!draft || !draft.name.trim() || !draft.baseURL.trim()) return;
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
      showNotice(
        result.catalog.status === "live" || result.catalog.status === "cache"
          ? `Провайдер сохранён. Найдено моделей: ${result.catalog.count ?? 0}.`
          : result.catalog.error || "Провайдер сохранён. Каталог моделей пока недоступен.",
        result.catalog.status === "unavailable",
      );
      const updated = await syncChannels(result.provider.id);
      const channel = updated.find((item) => item.id === result.provider.id) ?? result.provider;
      setSelectedId(channel.id);
      setDraft({
        id: channel.id,
        name: channel.name,
        protocol: channel.protocol,
        baseURL: channel.baseURL,
        enabled: channel.enabled,
        custom: channel.custom,
      });
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
    await providerChannelsApi.removeKey(draft.id);
    await Promise.all([loadAuth(), loadModels(true)]);
    const updated = await syncChannels(draft.id);
    const channel = updated.find((item) => item.id === draft.id) ?? null;
    showNotice("API-ключ отключён.");
    await loadChannelModels(channel, false);
  };

  const removeProvider = async () => {
    if (!draft?.id || !draft.custom) return;
    if (!window.confirm(`Удалить провайдера ${draft.name}? Ключ и его ручные модели тоже будут удалены.`)) return;
    await providerChannelsApi.remove(draft.id);
    await Promise.all([loadAuth(), loadModels(true)]);
    setDraft(null);
    setSelectedId(null);
    const next = await syncChannels(null);
    setSelectedId(next[0]?.id ?? null);
  };

  const resetBuiltin = async () => {
    if (!draft?.id || draft.custom) return;
    await providerChannelsApi.resetBuiltin(draft.id);
    const updated = await syncChannels(draft.id);
    const channel = updated.find((item) => item.id === draft.id) ?? null;
    if (channel) {
      setDraft({ id: channel.id, name: channel.name, protocol: channel.protocol, baseURL: channel.baseURL, enabled: channel.enabled, custom: channel.custom });
      await loadChannelModels(channel, true);
    }
    showNotice("Endpoint и параметры встроенного провайдера сброшены.");
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
      await Promise.all([loadModels(true), loadChannelModels(selected, false)]);
    } catch (error) {
      showNotice(errorText(error), true);
    } finally {
      setSaving(false);
    }
  };

  const removeManual = async (modelId: string) => {
    if (!selected) return;
    await providerChannelsApi.deleteManualModel(selected.id, modelId);
    await Promise.all([loadModels(true), loadChannelModels(selected, false)]);
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
                onClick={() => { setDraft(null); setSelectedId(channel.id); }}
                className={cn(
                  "mb-1 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                  selectedId === channel.id && draft?.id !== undefined ? "bg-background shadow-sm" : "hover:bg-muted/70",
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
                    {PROTOCOL_LABELS[channel.protocol]}
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
                    {status && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{status}</span>}
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
                  <span className="text-xs font-medium">Протокол</span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={draft.protocol}
                    disabled={!draft.custom && Boolean(draft.id)}
                    onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProviderProtocol })}
                  >
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic-compatible</option>
                    <option value="google">Google Gemini</option>
                  </select>
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
                  Можно указать обычный endpoint провайдера или совместимый relay endpoint. Для пользовательских URL runtime применяет SSRF-проверку.
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
                        {selected.connected
                          ? "Endpoint не вернул список моделей. Добавьте Model ID вручную ниже."
                          : "Сохраните API key, чтобы автоматически получить модели."}
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
