import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { type ModelEntry, useStore } from "../store/useStore";
import { CheckIcon, ChevronDownIcon } from "./icons";

function availabilityLabel(model: ModelEntry) {
  return model.status === "cache"
    ? "Последняя успешная версия каталога"
    : "Доступна";
}

function StatusDot({ model }: { model: ModelEntry }) {
  const stale = model.status === "cache";
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        stale ? "bg-amber-500" : "bg-emerald-500",
      )}
      title={availabilityLabel(model)}
      aria-label={availabilityLabel(model)}
    />
  );
}

function sourceLabel(model: ModelEntry) {
  if (model.source === "custom") return "custom endpoint";
  if (model.source === "discovered") return "discovery";
  if (model.source === "manual") return "manual";
  return null;
}

export default function ModelSelector() {
  const models = useStore((s) => s.models);
  const selectedModel = useStore((s) => s.selectedModel);
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const openModelSettings = () => {
    setOpen(false);
    setSettingsOpen(true);
  };

  if (models.length === 0) {
    return (
      <button
        type="button"
        className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onClick={openModelSettings}
      >
        Подключить модель
      </button>
    );
  }

  const current = models.find(
    (m) =>
      m.providerID === selectedModel?.providerID &&
      m.modelID === selectedModel?.modelID,
  );

  const personal = models.filter(
    (m) =>
      m.source === "manual" ||
        m.source === "custom" ||
        m.source === "discovered",
  );
  const providerModels = models.filter(
    (m) =>
      m.source !== "manual" &&
      m.source !== "custom" &&
      m.source !== "discovered",
  );

  const providerGrouped: Record<string, ModelEntry[]> = {};
  for (const model of providerModels) {
    const group = providerGrouped[model.providerName] ?? [];
    group.push(model);
    providerGrouped[model.providerName] = group;
  }

  const renderOption = (model: ModelEntry) => {
    const active =
      model.providerID === selectedModel?.providerID &&
      model.modelID === selectedModel?.modelID;
    const source = sourceLabel(model);
    return (
      <button
        type="button"
        key={`${model.providerID}/${model.modelID}`}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition",
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )}
        onClick={() => {
          setSelectedModel({
            providerID: model.providerID,
            modelID: model.modelID,
          });
          setOpen(false);
        }}
      >
        <span className="flex min-w-0 items-start gap-2">
          <StatusDot model={model} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-foreground">{model.modelName}</span>
              {model.free && (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
                  FREE
                </span>
              )}
              {source && (
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                  {source}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/80">
              {model.providerName}
              {model.status === "cache" ? " · cache" : ""}
            </span>
          </span>
        </span>
        {active && <CheckIcon size={14} />}
      </button>
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-[11px] text-foreground shadow-none transition hover:bg-accent md:px-3"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {current && <StatusDot model={current} />}
          <span className="truncate">{current?.modelName ?? "Выбрать модель"}</span>
          {current?.free && (
            <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
              FREE
            </span>
          )}
          {current && sourceLabel(current) && (
            <span className="hidden shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground sm:inline-flex">
              {sourceLabel(current)}
            </span>
          )}
        </span>
        <span className="shrink-0">
          <ChevronDownIcon size={14} />
        </span>
      </button>

      {open && (
        <div className="absolute left-1/2 top-full z-50 mt-2 max-h-[60dvh] w-[320px] max-w-[calc(100vw-1rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-e2 sm:w-[360px]">
          {personal.length > 0 && (
            <div className="mb-2">
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Мои модели
              </div>
              <div className="space-y-0.5">{personal.map(renderOption)}</div>
            </div>
          )}

          {Object.entries(providerGrouped).map(([providerName, list]) => (
            <div key={providerName} className="mb-2">
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {providerName}
              </div>
              <div className="space-y-0.5">{list.map(renderOption)}</div>
            </div>
          ))}

          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
              onClick={openModelSettings}
            >
              Управление моделями…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
