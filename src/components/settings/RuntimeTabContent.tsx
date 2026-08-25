import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import {
  parseRuntimeCapabilities,
  type RuntimeCapability,
  type RuntimeCapabilitySnapshot,
} from "@/api/runtimeCapabilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

const CAPABILITY_LABELS: Record<string, string> = {
  workspace: "Файлы workspace",
  shell: "Bash, сборка и тесты",
  executor: "Изолированный executor",
  browser: "Браузер и превью",
  web: "Интернет для агента",
  terminal: "Интерактивный терминал",
  ssh: "Удалённый SSH",
  installers: "Установка окружения",
  sudo: "Повышенные права",
};

const STATE_LABELS: Record<RuntimeCapability["state"], string> = {
  ready: "доступно",
  disabled: "отключено",
  failed: "ошибка",
  "local-fallback": "локальный режим",
};

function capabilityDetails(capability: RuntimeCapability): string {
  const details = [
    capability.mode,
    capability.required === true ? "обязателен" : null,
    capability.isolated === true ? "изолирован" : null,
    typeof capability.allowlistCount === "number"
      ? `хостов в allowlist: ${capability.allowlistCount}`
      : null,
  ].filter(Boolean);
  return details.join(" · ") || "Определено эффективной конфигурацией сервера";
}

function StatusBadge({ state }: { state: RuntimeCapability["state"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "whitespace-nowrap",
        state === "ready" && "border-success/30 bg-success/10 text-foreground",
        state === "failed" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
        state === "disabled" && "text-muted-foreground",
        state === "local-fallback" &&
          "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      {STATE_LABELS[state]}
    </Badge>
  );
}

export function RuntimeTabContent() {
  const [snapshot, setSnapshot] = useState<RuntimeCapabilitySnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const parsed = parseRuntimeCapabilities(await api.runtimeCapabilities());
      if (!parsed) throw new Error("Сервер вернул неизвестный формат данных");
      setSnapshot(parsed);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось получить возможности runtime",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Возможности агента"
        description="Фактическое состояние инструментов и границ доступа на этом сервере. Значения берутся из runtime, а не предполагаются интерфейсом."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Проверка…" : "Обновить"}
          </Button>
        }
      >
        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <SettingsCard>
          {snapshot ? (
            Object.entries(snapshot.capabilities).map(([name, capability]) => (
              <SettingsRow
                key={name}
                label={CAPABILITY_LABELS[name] ?? name}
                description={capabilityDetails(capability)}
              >
                <StatusBadge state={capability.state} />
              </SettingsRow>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {loading ? "Читаю конфигурацию runtime…" : "Нет данных"}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {snapshot && (
        <SettingsSection title="Эффективные политики">
          <SettingsCard>
            {Object.entries(snapshot.policies).map(([name, value]) => (
              <SettingsRow key={name} label={name}>
                <code className="text-xs text-muted-foreground">{value}</code>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      {snapshot && (
        <SettingsSection
          title={`Инструменты · ${snapshot.tools.length}`}
          description="Имена инструментов, которые модель реально получает в текущей конфигурации."
        >
          <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-card p-4">
            {snapshot.tools.map((tool) => (
              <Badge
                key={tool}
                variant="secondary"
                className="font-mono font-normal"
              >
                {tool}
              </Badge>
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
