import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type {
  ManualModel,
  ProviderCatalogModel,
  ProviderCatalogStatus,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ProviderInfo } from "@/config/providers";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useStore } from "@/store/useStore";
import { CheckIcon, CloseIcon, CopyIcon, KeyIcon } from "../icons";
import {
  humanizeModelError,
  manualStateLabel,
  manualUiState,
  providerStatusLabel,
} from "./modelUi";

type AddMode = "model" | "custom" | "discovery";
type ProbeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; latencyMs: number }
  | { kind: "error"; message: string };

const SOURCE_LABEL: Record<string, string> = {
  catalog: "CATALOG",
  manual: "MANUAL",
  custom: "CUSTOM",
  discovered: "DISCOVERY",
};

function providerStatusClass(status?: ProviderCatalogStatus | string) {
  if (status === "live") return "bg-emerald-500";
  if (status === "cache") return "bg-amber-500";
  if (status === "unauthorized" || status === "unavailable") return "bg-red-500";
  return "bg-muted-foreground/50";
}

/**
 * Настройка BYOK-провайдера и его моделей.
 *
 * UI намеренно показывает три разных сущности отдельно: обычную ручную модель,
 * OpenAI-compatible custom endpoint и finite discovery rule. В native runtime
 * они сходятся в единый owner-aware provider registry.
 */
export function ProviderSettingsModal({
  provider,
  open,
  onClose,
}: {
  provider: ProviderInfo;
  open: boolean;
  onClose: () => void;
}) {
  const authed = useStore((s) => s.authed);
  const saveKey = useStore((s) => s.saveKey);
  const removeKey = useStore((s) => s.removeKey);
  const loadModels = useStore((s) => s.loadModels);

  const configured = !!authed[provider.id];
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [models, setModels] = useState<ProviderCatalogModel[]>([]);
  const [manual, setManual] = useState<ManualModel[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [providerStatus, setProviderStatus] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const [addMode, setAddMode] = useState<AddMode>("model");
  const [newModelId, setNewModelId] = useState("");
  const [newName, setNewName] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newIsFree, setNewIsFree] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [probeState, setProbeState] = useState<ProbeState>({ kind: "idle" });
  const [adding, setAdding] = useState(false);

  const showNotice = (message: string, isError = false) => {
    setNotice(message);
    setNoticeError(isError);
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      const [cat, man, hid] = await Promise.all([
        api.listProviderCatalog(),
        api.listManualModels(provider.id),
        api.listHiddenModels(provider.id),
      ]);
      const providerModels = cat.models.filter(
        (m) =>
          m.sourceProviderID === provider.id ||
          (!m.sourceProviderID && m.providerID === provider.id),
      );
      setModels(providerModels);
      setManual(man.models ?? []);
      setHidden(new Set(hid.hidden ?? []));
      setProviderStatus(cat.providers?.[provider.id]?.status);
      const stamp = cat.generatedAt ?? Date.now();
      setUpdatedAt(
        new Date(stamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      await loadModels(true);
    } catch (err) {
      setModels([]);
      showNotice(humanizeModelError(err), true);
    } finally {
      setRefreshing(false);
    }
  }, [loadModels, provider.id]);

  useEffect(() => {
    if (!open) return;
    setKey("");
    setNotice(null);
    setProbeState({ kind: "idle" });
    void refresh();
  }, [open, refresh]);

  const connect = async () => {
    if (!key.trim()) return;
    setSaving(true);
    try {
      const ok = await saveKey(provider.id, key.trim());
      if (!ok) {
        showNotice("Провайдер отклонил ключ или соединение не удалось.", true);
        return;
      }
      setKey("");
      showNotice("API-ключ подключён.");
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(`Отключить API-ключ провайдера ${provider.name}?`)) return;
    await removeKey(provider.id);
    showNotice("API-ключ отключён.");
    setModels([]);
    setManual([]);
    setProviderStatus(undefined);
  };

  const resetAddForm = () => {
    setNewModelId("");
    setNewName("");
    setNewBaseUrl("");
    setNewIsFree(false);
    setNewPattern("");
    setProbeState({ kind: "idle" });
  };

  const probeDraft = async () => {
    const id = newModelId.trim();
    if (!id) return;
    setProbeState({ kind: "loading" });
    try {
      const result = await api.probeManualModel(provider.id, {
        modelId: id,
        baseUrl: addMode === "custom" ? newBaseUrl.trim() || null : null,
      });
      setProbeState(
        result.available
          ? { kind: "ok", latencyMs: result.latencyMs }
          : {
              kind: "error",
              message: "Модель не отвечает с подключённым ключом.",
            },
      );
    } catch (err) {
      setProbeState({ kind: "error", message: humanizeModelError(err) });
    }
  };

  const addExact = async () => {
    const id = newModelId.trim();
    if (!id) return;
    setAdding(true);
    try {
      const result = await api.addManualModel(provider.id, {
        modelId: id,
        name: newName.trim() || null,
        baseUrl: addMode === "custom" ? newBaseUrl.trim() || null : null,
        isFree: newIsFree,
      });
      if (result.available === true) {
        showNotice("Модель проверена, сохранена и добавлена в runtime-каталог.");
      } else {
        showNotice("Модель сохранена.");
      }
      resetAddForm();
      await refresh();
    } catch (err) {
      showNotice(humanizeModelError(err), true);
    } finally {
      setAdding(false);
    }
  };

  const addPattern = async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    setAdding(true);
    try {
      await api.addManualModel(provider.id, {
        modelId: pattern,
        pattern: true,
        isFree: newIsFree,
        enabled: true,
      });
      showNotice("Discovery rule сохранено. Найденные модели появятся в каталоге после проверки.");
      resetAddForm();
      await refresh();
    } catch (err) {
      showNotice(humanizeModelError(err), true);
    } finally {
      setAdding(false);
    }
  };

  const toggleManual = async (m: ManualModel) => {
    try {
      await api.addManualModel(provider.id, {
        modelId: m.model_id,
        name: m.name,
        baseUrl: m.base_url,
        isFree: m.is_free,
        pattern: m.pattern,
        enabled: !m.enabled,
      });
      await refresh();
    } catch (err) {
      showNotice(humanizeModelError(err), true);
    }
  };

  const toggleHidden = async (modelId: string, currentlyHidden: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (currentlyHidden) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
    try {
      await api.setModelHidden(provider.id, modelId, !currentlyHidden);
      await loadModels(true);
    } catch (err) {
      showNotice(humanizeModelError(err), true);
      await refresh();
    }
  };

  const deleteManual = async (m: ManualModel) => {
    if (!window.confirm(`Удалить ${m.pattern ? "правило" : "модель"} ${m.model_id}?`)) return;
    try {
      await api.deleteManualModel(provider.id, m.model_id);
      await refresh();
    } catch (err) {
      showNotice(humanizeModelError(err), true);
    }
  };

  const exactManual = manual.filter((m) => !m.pattern);
  const exactManualById = new Map(exactManual.map((m) => [m.model_id, m]));
  const catalogIds = new Set(models.map((m) => m.modelID));
  const modelRows = useMemo(
    () => [
      ...models.map((m) => ({
        id: m.modelID,
        name: m.modelName,
        free: m.free || Boolean(exactManualById.get(m.modelID)?.is_free),
        manual: exactManualById.get(m.modelID) ?? null,
        source: m.source || "catalog",
        status: m.status,
        endpoint: m.endpoint,
      })),
      ...exactManual
        .filter((m) => !catalogIds.has(m.model_id))
        .map((m) => ({
          id: m.model_id,
          name: m.name || m.model_id,
          free: m.is_free,
          manual: m,
          source: m.base_url ? "custom" : "manual",
          status: undefined,
          endpoint: m.base_url,
        })),
    ],
    [catalogIds, exactManual, exactManualById, models],
  );
  const patterns = manual.filter((m) => m.pattern);
  const discoveredCount = models.filter((m) => m.source === "discovered").length;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white"
              style={{ background: provider.color }}
            >
              {provider.name.charAt(0)}
            </div>
            <DialogTitle className="text-base">{provider.name}</DialogTitle>
            {configured && <CheckIcon size={14} />}
            {configured && providerStatus && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn("h-2 w-2 rounded-full", providerStatusClass(providerStatus))} />
                {providerStatusLabel(providerStatus)}
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-5 pb-5">
          <section className="space-y-2">
            <div className="text-xs font-medium">API-ключ</div>
            {configured ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs">
                <span className="flex items-center gap-1.5 text-foreground">
                  <KeyIcon size={13} /> API-ключ подключён
                </span>
                <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" onClick={disconnect}>
                  Отключить
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="password"
                  className="h-8 min-w-[220px] flex-1"
                  placeholder={provider.keyHint}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void connect()}
                />
                <Button size="sm" disabled={!key.trim() || saving} onClick={() => void connect()}>
                  {saving ? "Подключаем…" : "Подключить"}
                </Button>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-medium">Каталог моделей</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {updatedAt
                    ? `${models.length} моделей · обновлено ${updatedAt}`
                    : "Каталог ещё не загружен"}
                </div>
              </div>
              <Button size="sm" variant="outline" disabled={!configured || refreshing} onClick={() => void refresh()}>
                {refreshing ? "Обновляем…" : "Обновить каталог"}
              </Button>
            </div>

            {notice && (
              <div className={cn("rounded-lg px-3 py-2 text-xs", noticeError ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground")}>
                {notice}
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-border">
              {modelRows.length === 0 ? (
                <div className="px-3 py-5 text-xs text-muted-foreground">
                  {configured
                    ? "Моделей нет. Обновите каталог или добавьте ручную модель ниже."
                    : "Подключите API-ключ, чтобы увидеть доступные модели."}
                </div>
              ) : (
                <div className="max-h-72 divide-y divide-border overflow-y-auto">
                  {modelRows.map((m) => {
                    const checked = m.manual ? m.manual.enabled : !hidden.has(m.id);
                    const manualState = m.manual
                      ? manualUiState(provider.id, m.manual, models)
                      : null;
                    return (
                      <div key={`${m.source}-${m.id}`} className="flex items-start gap-2 px-3 py-2.5 text-xs">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            if (m.manual) void toggleManual(m.manual);
                            else void toggleHidden(m.id, hidden.has(m.id));
                          }}
                          className="mt-0.5 accent-[var(--color-foreground)]"
                          aria-label={`Показывать ${m.id}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-medium">{m.name}</span>
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">
                              {SOURCE_LABEL[m.source] || m.source.toUpperCase()}
                            </span>
                            {m.free && (
                              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold">FREE</span>
                            )}
                            {manualState && (
                              <span className={cn("text-[10px]", manualState === "available" ? "text-emerald-600" : manualState === "stale" ? "text-amber-600" : manualState === "unavailable" ? "text-destructive" : "text-muted-foreground")}>
                                {manualStateLabel(manualState)}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                            <span className="font-mono">{m.id}</span>
                            {m.endpoint && (
                              <span className="max-w-full truncate font-mono" title={m.endpoint}>{m.endpoint}</span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => void copyText(m.id)}
                          aria-label={`Копировать ID ${m.id}`}
                        >
                          <CopyIcon size={11} />
                        </button>
                        {m.manual && (
                          <button
                            type="button"
                            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                            onClick={() => void deleteManual(m.manual!)}
                            aria-label={`Удалить ${m.id}`}
                          >
                            <CloseIcon size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-4">
            <div>
              <div className="text-xs font-medium">Добавить</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Обычная модель и custom endpoint проверяются до сохранения. Discovery перебирает только конечный набор кандидатов.
              </div>
            </div>

            <div className="inline-flex w-fit rounded-full border border-border bg-muted/30 p-1">
              {([
                ["model", "Модель"],
                ["custom", "Custom endpoint"],
                ["discovery", "Discovery"],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setAddMode(mode);
                    setProbeState({ kind: "idle" });
                  }}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs transition",
                    addMode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {addMode === "discovery" ? (
              <div className="space-y-2 rounded-xl border border-border bg-muted/10 p-3">
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="glm-{4.5,4.6,4.7,5}-flash"
                  value={newPattern}
                  onChange={(event) => setNewPattern(event.target.value)}
                />
                <div className="text-[10px] leading-relaxed text-muted-foreground">
                  Скобки создают конечный набор вариантов. <code>*</code> фильтрует только уже известные ID; сервер ограничивает discovery максимум 64 кандидатами.
                </div>
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={newIsFree} onChange={(event) => setNewIsFree(event.target.checked)} />
                  найденные модели бесплатные
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={!configured || !newPattern.trim() || adding} onClick={() => void addPattern()}>
                    {adding ? "Сохраняем…" : "Добавить discovery rule"}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">Сейчас найдено discovery: {discoveredCount}</span>
                </div>
              </div>
            ) : (
              <div className="space-y-2 rounded-xl border border-border bg-muted/10 p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    className="h-8 font-mono text-xs"
                    placeholder="Model ID"
                    value={newModelId}
                    onChange={(event) => {
                      setNewModelId(event.target.value);
                      setProbeState({ kind: "idle" });
                    }}
                  />
                  <Input
                    className="h-8 text-xs"
                    placeholder="Название (опционально)"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                  />
                </div>
                {addMode === "custom" && (
                  <>
                    <Input
                      className="h-8 font-mono text-xs"
                      placeholder="https://api.example.com/v1"
                      value={newBaseUrl}
                      onChange={(event) => {
                        setNewBaseUrl(event.target.value);
                        setProbeState({ kind: "idle" });
                      }}
                    />
                    <div className="text-[10px] text-muted-foreground">
                      Endpoint должен быть публичным OpenAI-compatible API. Используется тот же ключ, что подключён к {provider.name}.
                    </div>
                  </>
                )}
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={newIsFree} onChange={(event) => setNewIsFree(event.target.checked)} />
                  бесплатная
                </label>
                {probeState.kind !== "idle" && (
                  <div className={cn("rounded-lg px-2.5 py-2 text-[11px]", probeState.kind === "ok" ? "bg-emerald-500/10 text-emerald-700" : probeState.kind === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                    {probeState.kind === "loading" && "Проверяем соединение и Model ID…"}
                    {probeState.kind === "ok" && `Модель доступна · ${probeState.latencyMs} ms`}
                    {probeState.kind === "error" && probeState.message}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!configured || !newModelId.trim() || probeState.kind === "loading" || (addMode === "custom" && !newBaseUrl.trim())}
                    onClick={() => void probeDraft()}
                  >
                    Проверить
                  </Button>
                  <Button
                    size="sm"
                    disabled={!configured || !newModelId.trim() || adding || (addMode === "custom" && !newBaseUrl.trim())}
                    onClick={() => void addExact()}
                  >
                    {adding ? "Проверяем…" : "Проверить и добавить"}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
