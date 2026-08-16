import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

const STAGES = ["Анализ", "Изменения", "Проверка"] as const;

function humanActivity(label: string): string {
  const value = label.trim().toLowerCase();
  if (value.includes("читает") || value.includes("думает"))
    return "анализирует проект";
  if (value.includes("интернет")) return "ищет информацию";
  if (value.includes("создаёт") || value.includes("редактирует"))
    return "вносит изменения";
  if (value.includes("команд")) return "проверяет результат";
  if (value.includes("план")) return "обновляет план";
  if (value.includes("подзадач")) return "анализирует задачу";
  if (value.includes("вопрос")) return "уточняет детали";
  if (value.includes("пишет ответ")) return "готовит результат";
  if (value.includes("действ")) return "выполняет задачу";
  return value.replace(/…|\.\.\.$/g, "") || "выполняет задачу";
}

/**
 * Current coarse-grained product stage. This is intentionally user-facing:
 * it does not expose internal tool names or implementation details.
 */
function stageFor(label: string): number {
  const value = label.trim().toLowerCase();
  if (value.includes("создаёт") || value.includes("редактирует")) return 1;
  if (value.includes("команд")) return 2;
  if (value.includes("пишет ответ")) return 3;
  return 0;
}

export function AgentIndicator({
  label = "думает…",
  meta,
}: {
  label?: string;
  meta?: string | undefined;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const activity = useMemo(() => humanActivity(label), [label]);
  const stage = useMemo(() => stageFor(label), [label]);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="oc-thinking min-w-0">
      <div className="oc-aura">
        <div className="oc-aura-glow" />
        <div className="oc-aura-mark">&gt;_</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="shrink-0 font-medium text-foreground/90">Работает</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="min-w-0 truncate text-muted-foreground">{activity}</span>
          {meta && (
            <span className="hidden shrink-0 font-mono text-[10.5px] text-muted-foreground/50 sm:inline">
              · {meta}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/50">
            {mm}:{ss}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5" aria-label="Этапы выполнения">
          {STAGES.map((name, index) => {
            const done = stage > index;
            const active = stage === index;
            return (
              <div key={name} className="flex min-w-0 items-center gap-1.5">
                {index > 0 && (
                  <span className="text-[9px] text-muted-foreground/30">→</span>
                )}
                <span
                  className={cn(
                    "whitespace-nowrap text-[10.5px] transition-colors",
                    done && "text-foreground/70",
                    active && "font-medium text-foreground",
                    !done && !active && "text-muted-foreground/45",
                  )}
                >
                  {done ? "✓ " : active ? "● " : ""}
                  {name}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default AgentIndicator;
