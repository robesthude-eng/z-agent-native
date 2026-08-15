import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type {
  ManualModel,
  ProviderCatalogResponse,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import { PROVIDERS, type ProviderInfo } from "@/config/providers";
import { cn } from "@/lib/utils";
import { useStore } from "@/store/useStore";
import { CloseIcon } from "../icons";
import { ProviderSettingsModal } from "./ProviderSettingsModal";
import {
  findManualCatalogEntry,
  humanizeModelError,
  manualStateLabel,
  manualUiState,
  providerStatusLabel,
  type ManualUiState,
} from "./modelUi";
import { SettingsSection } from "./primitives";

type ProviderManual = {
  provider: ProviderInfo;
  models: ManualModel[];
};

type ProbeResult =
  | { kind: "ok"; latencyMs: number; checkedAt: number }
  | { kind: "fail"; message: string; checkedAt: number };

function StateDot({ state }: { state: ManualUiState }) {
  const label = manualStateLabel(state);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          state === "available" && "bg-emerald-500",
          state === "stale" && "bg-amber-500",
          state === "hidden" && "bg-muted-foreground/50",
          state === "unavailable" && "bg-red-500",
        )}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

export function MyModelsSection() {
  const authed = useStore((s) => s.authed);
  const loadModels = useStore((s) => s.loadModels);
  const [catalog, setCatalog] = useState<ProviderCatalogResponse>({ models: [] });
  const [manualByProvider, setManualByProvider] = useState<ProviderManual[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderInfo | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextCatalog, allManual] = await Promise.all([
        api.listProviderCatalog(),
        api.listAllManualModels(),
      ]);
      setCatalog(nextCatalog);
      setManualByProvider(
        PROVIDERS.flatMap((provider) => {
          const models = allManual.providers?.[provider.id] ?? [];
          return models.length > 0 ? [{ provider, models }] : [];
        }),
      );
      await loadModels(true);
    } catch (err) {
      setError(humanizeModelError(err));
    } finally {
      setLoading(false);
    }
  }, [loadModels]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(
    () =>
      manualByProvider.flatMap(({ provider, models }) =>
        models.map((model) => ({ provider, model })),
      ),
    [manualByProvider],
  );
  const exactRows = rows.filter(({ model }) => !model.pattern);
  const patternRows = rows.filter(({ model }) => model.pattern);
  const hiddenCount = Object.values(catalog.hidden ?? {}).reduce(
    (sum, items) => sum + items.length,
    0,
  );
  const discoveredCount = catalog.models.filter(
    (model) => model.source === "discovered",
  ).length;
  const connected = PROVIDERS.filter((provider) => authed[provider.id]);

  const rowKey = (providerId: string, modelId: string) =>
    `${providerId}/${modelId}`;
  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusyRows((prev) => new Set(prev).add(key));
    try {
      await fn();
    } finally {
      setBusyRows((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const testModel = async (provider: ProviderInfo, model: ManualModel) => {
    const key = rowKey(provider.id, model.model_id);
    await withBusy(key, async () => {
      try {
        const result = await api.probeManualModel(provider.id, {
          modelId: model.model_id,
          baseUrl: model.base_url,
        });
        setProbeResults((prev) => ({
          ...prev,
          [key]: result.available
            ? {
                kind: "ok",
                latencyMs: result.latencyMs,
                checkedAt: result.checkedAt,
              }
            : {
                kind: "fail",
                message: "Модель не ответила с текущим ключом.",
                checkedAt: result.checkedAt,
              },
        }));
      } catch (err) {
        setProbeResults((prev) => ({
          ...prev,
          [key]: {
            kind: "fail",
            message: humanizeModelError(err),
            checkedAt: Date.now(),
          },
        }));
      }
    });
  };

  const toggleModel = async (provider: ProviderInfo, model: ManualModel) => {
    const key = rowKey(provider.id, model.model_id);
    await withBusy(key, async () => {
      try {
        await api.addManualModel(provider.id, {
          modelId: model.model_id,
          name: model.name,
          baseUrl: model.base_url,
          isFree: model.is_free,
          pattern: model.pattern,
          enabled: !model.enabled,
        });
        await refresh();
      } catch (err) {
        setError(humanizeModelError(err));
      }
    });
  };

  const deleteModel = async (provider: ProviderInfo, model: ManualModel) => {
    if (!window.confirm(`Удалить ${model.pattern ? "паттерн" : "модель"} ${model.model_id}?`)) return;
    const key = rowKey(provider.id, model.model_id);
    await withBusy(key, async () => {
      try {
        await api.deleteManualModel(provider.id, model.model_id);
        await refresh();
      } catch (err) {
        setError(humanizeModelError(err));
      }
    });
  };

  const updatedAt = catalog.generatedAt
    ? new Date(catalog.generatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      <SettingsSection
        title="Мои модели"
        description="Ручные модели, custom endpoints и правила автообнаружения. Статус берётся из того же runtime-каталога, который получает движок."
        actions={
          <div className="flex items-center gap-2">
            <select
              aria-label="Добавить модель для провайдера"
              className="h-8 max-w-44 rounded-full border border-border bg-background px-3 text-xs"
              value=""
              onChange={(event) => {
                const provider = PROVIDERS.find((p) => p.id === event.target.value);
                if (provider) setSelectedProvider(provider);
              }}
            >
              <option value="">Добавить модель…</option>
              {connected.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
              {loading ? "Обновляем…" : "Обновить"}
            </Button>
          </div>
        }
      >
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="text-xs text-muted-foreground">
              {exactRows.length} моделей · {patternRows.length} правил discovery
              {updatedAt ? ` · каталог ${updatedAt}` : ""}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {hiddenCount} скрыто · {discoveredCount} найдено discovery
            </div>
          </div>

          {error && (
            <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {rows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              Ручных моделей пока нет. Подключите ключ провайдера и выберите «Добавить модель…».
            </div>
          ) : (
            <div className="divide-y divide-border">
              {exactRows.map(({ provider, model }) => {
                const key = rowKey(provider.id, model.model_id);
                const state = manualUiState(provider.id, model, catalog.models);
                const entry = findManualCatalogEntry(provider.id, model, catalog.models);
                const probe = probeResults[key];
                const busy = busyRows.has(key);
                return (
                  <div key={key} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {model.name || model.model_id}
                          </span>
                          <StateDot state={state} />
                          {model.is_free && (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold">FREE</span>
                          )}
                          {model.base_url && (
                            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              CUSTOM ENDPOINT
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>{provider.name}</span>
                          <span className="font-mono">{model.model_id}</span>
                          {model.base_url && (
                            <span className="max-w-full truncate font-mono" title={model.base_url}>
                              {model.base_url}
                            </span>
                          )}
                          {entry?.providerID && entry.providerID !== provider.id && (
                            <span title="Runtime provider ID">runtime: {entry.providerID}</span>
                          )}
                        </div>
                        {probe && (
                          <div className={cn("mt-1 text-[11px]", probe.kind === "ok" ? "text-emerald-600" : "text-destructive")}>
                            {probe.kind === "ok"
                              ? `Проверено: доступна · ${probe.latencyMs} ms`
                              : probe.message}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Button size="sm" variant="ghost" disabled={busy || !model.enabled} onClick={() => void testModel(provider, model)}>
                          Проверить
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleModel(provider, model)}>
                          {model.enabled ? "Скрыть" : "Показать"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelectedProvider(provider)}>
                          Настроить
                        </Button>
                        <button
                          type="button"
                          className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                          disabled={busy}
                          onClick={() => void deleteModel(provider, model)}
                          aria-label={`Удалить ${model.model_id}`}
                        >
                          <CloseIcon size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {patternRows.map(({ provider, model }) => {
                const key = rowKey(provider.id, model.model_id);
                const count = catalog.models.filter(
                  (entry) =>
                    entry.source === "discovered" &&
                    (entry.sourceProviderID === provider.id || entry.providerID === provider.id),
                ).length;
                const busy = busyRows.has(key);
                return (
                  <div key={key} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">Discovery · {provider.name}</span>
                          <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]", model.enabled ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground")}>
                            {model.enabled ? `активно · найдено ${count}` : "выключено"}
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {model.model_id}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleModel(provider, model)}>
                          {model.enabled ? "Выключить" : "Включить"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setSelectedProvider(provider)}>
                          Настроить
                        </Button>
                        <button
                          type="button"
                          className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-destructive"
                          onClick={() => void deleteModel(provider, model)}
                          aria-label={`Удалить паттерн ${model.model_id}`}
                        >
                          <CloseIcon size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <details className="border-t border-border px-4 py-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Диагностика каталога</summary>
            <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
              <div>Runtime моделей: {catalog.models.length}</div>
              <div>Ручных записей: {rows.length}</div>
              {Object.entries(catalog.providers ?? {}).map(([id, status]) => (
                <div key={id} className="flex justify-between gap-2 rounded-lg bg-muted/40 px-2 py-1.5">
                  <span>{PROVIDERS.find((p) => p.id === id)?.name || id}</span>
                  <span>{providerStatusLabel(status.status)} · {status.count}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      </SettingsSection>

      {selectedProvider && (
        <ProviderSettingsModal
          provider={selectedProvider}
          open
          onClose={() => {
            setSelectedProvider(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}
