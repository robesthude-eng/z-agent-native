import { useCallback, useEffect, useState } from "react";
import { api, type SystemStatus } from "@/api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes } from "./DataTabContent";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

const REFRESH_MS = 15_000;

function formatDuration(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

function ago(ms: number) {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 90) return "только что";
  if (sec < 3600) return `${Math.round(sec / 60)} мин назад`;
  if (sec < 86400 * 2) return `${Math.round(sec / 3600)} ч назад`;
  return `${Math.round(sec / 86400)} дн назад`;
}

function Meter({
  label,
  used,
  total,
  hint,
}: {
  label: string;
  used: number;
  total: number;
  hint?: string;
}) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  const tone =
    pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-warning" : "bg-primary/70";
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {formatBytes(used)} из {formatBytes(total)} · {Math.round(pct)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${Math.max(1, pct)}%` }}
        />
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        tone === "ok" && "bg-emerald-500",
        tone === "warn" && "bg-warning",
        tone === "bad" && "bg-destructive",
        tone === "idle" && "bg-muted-foreground/40",
      )}
    />
  );
}

const SERVICE_LABELS: Record<string, string> = {
  "z-agent": "Приложение",
  "z-agent-executor": "Исполнитель команд",
  "z-agent-browser": "Браузер",
  "z-agent-browser-egress": "Выход браузера в сеть",
  "z-agent-search": "Поиск (SearXNG)",
  caddy: "Caddy (HTTPS)",
};

/** Раздел «Сервер»: диск, память, нагрузка, контейнеры и бэкап. */
export function ServerTabContent() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setStatus(await api.systemStatus());
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /403/.test(msg) || /администратор/i.test(msg)
          ? "Раздел доступен только администратору."
          : "Не удалось получить состояние сервера.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!status) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {loading ? "Загружаю состояние сервера…" : error}
      </div>
    );
  }

  const { memory, host, app, hostAgent } = status;
  const disk = hostAgent?.rootDisk ?? status.disk;
  const containers = hostAgent?.containers ?? [];
  const backup = hostAgent?.backup;
  const last = backup?.lastSuccess;
  const backupAge = last?.finishedAt ? Date.now() - last.finishedAt : null;
  const backupTone: "ok" | "warn" | "bad" | "idle" = backup?.running
    ? "warn"
    : backupAge == null
      ? "idle"
      : backupAge > 2 * 86400_000 || backup?.lastResult === "exit-code"
        ? "bad"
        : "ok";
  const loadPct = host.cpus ? ((host.load[0] ?? 0) / host.cpus) * 100 : 0;

  return (
    <div className="space-y-8">
      <SettingsSection
        title={`Ресурсы · ${host.hostname}`}
        description={`Обновляется каждые ${REFRESH_MS / 1000} с. Сервер работает ${formatDuration(host.uptime)}.`}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
          >
            Обновить
          </Button>
        }
      >
        <SettingsCard>
          {disk && (
            <Meter
              label="Диск"
              used={disk.used}
              total={disk.total}
              hint={`Свободно ${formatBytes(disk.free)}`}
            />
          )}
          <Meter
            label="Память"
            used={memory.used}
            total={memory.total}
            hint={`Доступно ${formatBytes(memory.available)}${
              memory.swapTotal
                ? ` · swap ${formatBytes(memory.swapUsed)} из ${formatBytes(memory.swapTotal)}`
                : ""
            }`}
          />
          <SettingsRow
            label="Нагрузка процессора"
            description={`${host.cpus} ядра · среднее за 1 / 5 / 15 мин`}
          >
            <span
              className={cn(
                "text-sm tabular-nums",
                loadPct >= 90 ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {host.load.map((l) => l.toFixed(2)).join(" / ")}
            </span>
          </SettingsRow>
          <SettingsRow
            label="Приложение"
            description={`Node ${app.node} · работает ${formatDuration(app.uptime)}`}
          >
            <span className="text-sm tabular-nums text-muted-foreground">
              {formatBytes(app.rss)} · ходов: {app.activeTurns}
            </span>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Контейнеры"
        description={
          hostAgent
            ? `Снимок ${ago(hostAgent.generatedAt)}${hostAgent.stale ? " — устарел, проверьте z-agent-host-status.timer" : ""}.`
            : "Нет данных с хоста: не установлен z-agent-host-status (см. deploy/host)."
        }
      >
        {containers.length > 0 && (
          <SettingsCard>
            {containers.map((c) => {
              const tone =
                c.state !== "running"
                  ? "bad"
                  : c.health === "unhealthy"
                    ? "bad"
                    : c.health === "starting"
                      ? "warn"
                      : "ok";
              return (
                <div
                  key={c.name}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Dot tone={tone} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {SERVICE_LABELS[c.service] ?? c.service}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {c.status}
                      </div>
                    </div>
                  </div>
                  {c.state === "running" && (
                    <div className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      <div>CPU {c.cpu || "—"}</div>
                      <div>
                        {c.mem ? (c.mem.split("/")[0] ?? "").trim() : "—"}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </SettingsCard>
        )}
      </SettingsSection>

      {backup && (
        <SettingsSection
          title="Бэкап в Google Drive"
          description="Шифрованный restic-снимок базы и файлов проектов, раз в сутки."
        >
          <SettingsCard>
            <SettingsRow
              label="Последний успешный"
              description={
                last?.finishedAt
                  ? `${new Date(last.finishedAt).toLocaleString()}${last.size ? ` · ${last.size}` : ""}${last.verify ? ` · проверка базы: ${last.verify}` : ""}${last.snapshots ? ` · снимков: ${last.snapshots}` : ""}`
                  : "Ещё не было"
              }
            >
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Dot tone={backupTone} />
                {backup.running
                  ? "идёт сейчас"
                  : last?.finishedAt
                    ? ago(last.finishedAt)
                    : "—"}
              </span>
            </SettingsRow>
            {backup.lastResult && backup.lastResult !== "success" && (
              <SettingsRow
                label="Последний запуск завершился ошибкой"
                description={`Результат: ${backup.lastResult}, код ${backup.lastExitStatus}. Смотрите journalctl -u z-agent-backup.`}
              />
            )}
            <SettingsRow
              label="Следующий"
              {...(backup.timerActive
                ? {}
                : { description: "Таймер выключен!" })}
            >
              <span className="text-sm text-muted-foreground">
                {backup.nextAt ? new Date(backup.nextAt).toLocaleString() : "—"}
              </span>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  );
}
