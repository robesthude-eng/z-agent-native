import { useState } from "react";
import { cn } from "@/lib/utils";
import { PROVIDERS } from "../../config/providers";
import { useStore } from "../../store/useStore";
import { CheckIcon } from "../icons";
import { ProviderSettingsModal } from "./ProviderSettingsModal";
import { SettingsSection } from "./primitives";

/**
 * "Bring your own API key" (BYOK) providers tab.
 *
 * Карточки провайдеров; клик по карточке открывает модальное окно настройки
 * (ключ, URL, «Подключить», «Обновить модели», список моделей с галочками,
 * добавление/удаление ручных моделей).
 */
export function ProvidersTabContent() {
  const authed = useStore((s) => s.authed);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const selected = PROVIDERS.find((p) => p.id === selectedProvider) ?? null;

  return (
    <SettingsSection
      title="Свой API-ключ (BYOK)"
      description="Платные провайдеры без хранения ваших данных (zero retention). Нажмите на карточку, чтобы настроить."
    >
      <div className="grid sm:grid-cols-2 gap-3">
        {PROVIDERS.map((p) => {
          const configured = !!authed[p.id];
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedProvider(p.id)}
              className={cn(
                "rounded-xl border p-3 bg-card text-left hover:border-primary/50 transition-colors",
                configured && "border-foreground/25",
              )}
            >
              <div className="flex items-center gap-3 mb-2">
                <div
                  className="h-8 w-8 rounded-lg flex items-center justify-center text-white text-sm font-bold"
                  style={{ background: p.color }}
                >
                  {p.name.charAt(0)}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-1.5">
                    {p.name} {configured && <CheckIcon size={14} />}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {p.models}
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {configured
                  ? "API-ключ подключён — нажмите, чтобы настроить"
                  : "Не подключён — нажмите, чтобы подключить"}
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <ProviderSettingsModal
          provider={selected}
          open={!!selectedProvider}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </SettingsSection>
  );
}
