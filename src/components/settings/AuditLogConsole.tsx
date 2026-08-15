import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AuditLogConsole({
  auditLogs,
  loadAuditLogs,
}: {
  auditLogs: string[];
  loadAuditLogs: () => void;
}) {
  // Сервер отдаёт лог как массив голых строк без id, поэтому идентичность
  // строки — её содержимое, а не позиция: при дозагрузке лога новые записи
  // сдвигают индексы и React переиспользовал бы DOM-узлы с чужой подсветкой.
  // Счётчик повторов нужен для одинаковых строк в одном ответе (уникальный key).
  const rows = useMemo(() => {
    const seen = new Map<string, number>();
    return auditLogs.map((log) => {
      const repeat = (seen.get(log) ?? 0) + 1;
      seen.set(log, repeat);
      return { key: `${log}#${repeat}`, log };
    });
  }, [auditLogs]);

  return (
    <div className="border-t border-border pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-muted-foreground">
          Консоль событий (логи самоулучшения)
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[11px]"
          onClick={loadAuditLogs}
          type="button"
        >
          Обновить
        </Button>
      </div>
      <div className="max-h-44 overflow-y-auto rounded-lg bg-zinc-950 text-zinc-300 font-mono text-[11px] leading-relaxed p-3 border border-border">
        {auditLogs.length === 0 ? (
          <div className="text-zinc-500 italic">
            Лог событий пуст. Выполните действие, чтобы наполнить консоль.
          </div>
        ) : (
          rows.map(({ key, log }) => {
            let color = "text-zinc-300";
            if (log.includes("SUCCESS")) color = "text-foreground";
            else if (log.includes("FAILED")) color = "text-red-400";
            else if (log.includes("WARNING")) color = "text-amber-400";
            else if (log.includes("START")) color = "text-sky-400";
            return (
              <div
                key={key}
                className={cn("whitespace-pre-wrap break-all", color)}
              >
                {log}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
