import type { ProviderChannel } from "@/api/providerChannels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, tf } from "@/i18n";
import { cn } from "@/lib/utils";
import { CloseIcon, SearchIcon } from "../../icons";
import type {
  ListedModel,
  ManualRow,
  ProbeState,
} from "../providerChannelModel";

interface ProviderModelsSectionProps {
  channel: ProviderChannel;
  models: ListedModel[];
  visibleModels: ListedModel[];
  manualModels: ManualRow[];
  hiddenModels: Set<string>;
  query: string;
  status: string | null;
  refreshing: boolean;
  saving: boolean;
  manualId: string;
  manualName: string;
  manualFree: boolean;
  manualBusy: string | null;
  probe: ProbeState;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  onToggleModel: (modelId: string) => void;
  onManualIdChange: (value: string) => void;
  onManualNameChange: (value: string) => void;
  onManualFreeChange: (value: boolean) => void;
  onProbe: () => void;
  onAddManual: () => void;
  onToggleManualEnabled: (model: ManualRow) => void;
  onToggleManualFree: (model: ManualRow) => void;
  onRemoveManual: (modelId: string) => void;
}

export function ProviderModelsSection({
  channel,
  models,
  visibleModels,
  manualModels,
  hiddenModels,
  query,
  status,
  refreshing,
  saving,
  manualId,
  manualName,
  manualFree,
  manualBusy,
  probe,
  onQueryChange,
  onRefresh,
  onToggleModel,
  onManualIdChange,
  onManualNameChange,
  onManualFreeChange,
  onProbe,
  onAddManual,
  onToggleManualEnabled,
  onToggleManualFree,
  onRemoveManual,
}: ProviderModelsSectionProps) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">
            {t("settings_panel.modeli")}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {models.length} из API · {manualModels.length} добавлено вручную
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!channel.connected || !channel.enabled || refreshing}
          onClick={onRefresh}
        >
          {refreshing
            ? t("provider_channel_manager.zagruzhaem")
            : t("provider_channel_manager.obnovit_modeli")}
        </Button>
      </div>

      {models.length > 0 && (
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            <SearchIcon size={13} />
          </span>
          <Input
            className="h-8 pl-8 text-xs"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("provider_channel_manager.poisk_modeli")}
          />
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
        {visibleModels.length === 0 ? (
          <div className="px-3 py-5 text-xs text-muted-foreground">
            {!channel.enabled
              ? t(
                  "provider_channel_manager.kanal_vyklyuchen_vklyuchite_ego_chtoby_zagru",
                )
              : !channel.connected
                ? t(
                    "provider_channel_manager.sohranite_api_key_chtoby_avtomaticheski_polu",
                  )
                : status === "unavailable"
                  ? t(
                      "provider_channel_manager.katalog_modeley_seychas_nedostupen_povtorite",
                    )
                  : status === "unauthorized"
                    ? t("provider_channel_manager.api_klyuch_ne_daet_dostup_k")
                    : t(
                        "provider_channel_manager.endpoint_ne_vernul_spisok_modeley_dobavte",
                      )}
          </div>
        ) : (
          visibleModels.map((model) => (
            <label
              key={model.id}
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted/30"
            >
              <input
                type="checkbox"
                checked={!hiddenModels.has(model.id)}
                onChange={() => onToggleModel(model.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {model.name || model.id}
                </span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {model.id}
                </span>
              </span>
            </label>
          ))
        )}
      </div>

      <div className="rounded-xl border border-dashed border-border p-3">
        <div className="mb-2 text-xs font-medium">
          {t("provider_channel_manager.dobavit_model_id_vruchnuyu")}
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Input
            className="h-8 font-mono text-xs"
            value={manualId}
            onChange={(event) => onManualIdChange(event.target.value)}
            placeholder="model-id"
          />
          <Input
            className="h-8 text-xs"
            value={manualName}
            onChange={(event) => onManualNameChange(event.target.value)}
            placeholder={t("provider_channel_manager.nazvanie_neobyazatelno")}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={manualFree}
              onChange={(event) => onManualFreeChange(event.target.checked)}
            />
            Бесплатная
          </label>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={
              !manualId.trim() ||
              probe.kind === "checking" ||
              !channel.connected ||
              !channel.enabled
            }
            onClick={onProbe}
          >
            {probe.kind === "checking"
              ? t("provider_channel_manager.proveryaem")
              : t("provider_channel_manager.proverit")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !manualId.trim() ||
              saving ||
              !channel.connected ||
              !channel.enabled
            }
            onClick={onAddManual}
          >
            Добавить
          </Button>
        </div>
        {(probe.kind === "ok" || probe.kind === "fail") && (
          <div
            className={cn(
              "mt-2 text-[11px]",
              probe.kind === "ok" ? "text-emerald-700" : "text-destructive",
            )}
          >
            {probe.kind === "ok"
              ? tf("provider_channel_manager.model_otvetila_za_0_ms_mozhno", [
                  probe.latencyMs,
                ])
              : probe.message}
          </div>
        )}
        {manualModels.length > 0 && (
          <div className="mt-3 space-y-1">
            {manualModels.map((model) => (
              <div
                key={model.model_id}
                className="flex items-center gap-2 rounded-lg bg-muted/35 px-2.5 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={model.enabled}
                  disabled={manualBusy === model.model_id}
                  onChange={() => onToggleManualEnabled(model)}
                  aria-label={tf(
                    "provider_channel_manager.pokazyvat_0_v_spiske_modeley",
                    [model.model_id],
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate font-mono text-[11px]",
                      !model.enabled && "text-muted-foreground line-through",
                    )}
                  >
                    {model.model_id}
                  </span>
                  {model.name && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {model.name}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  disabled={manualBusy === model.model_id}
                  aria-pressed={model.is_free}
                  onClick={() => onToggleManualFree(model)}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                    model.is_free
                      ? "bg-emerald-500/10 text-emerald-700"
                      : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                  title={
                    model.is_free
                      ? t(
                          "provider_channel_manager.otmetka_besplatnaya_vklyuchena",
                        )
                      : t("provider_channel_manager.otmetit_kak_besplatnuyu")
                  }
                >
                  FREE
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:text-destructive"
                  onClick={() => onRemoveManual(model.model_id)}
                  aria-label={tf("provider_channel_manager.udalit_0", [
                    model.model_id,
                  ])}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
