import { useEffect, useState } from "react";
import type { AgentActivity } from "@/lib/agentActivity";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/**
 * Индикатор работы агента внизу ленты.
 *
 * Здесь была выдуманная цепочка «Анализ → Изменения → Проверка»: стадии
 * выводились из текста подписи и к фактическому ходу отношения не имели,
 * а почти любое действие подписывалось как «анализирует проект». Теперь всё
 * содержимое приходит из describeAgentActivity — то есть из реальных вызовов
 * инструментов текущего хода.
 */
export function AgentIndicator({ activity }: { activity: AgentActivity }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
          <span className="shrink-0 font-medium text-foreground/90">
            {activity.label}
          </span>
          {activity.detail && (
            <>
              <span className="shrink-0 text-muted-foreground/40">·</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {activity.detail}
              </span>
            </>
          )}
          {activity.step > 0 && (
            <span className="hidden shrink-0 text-[10.5px] text-muted-foreground/50 sm:inline">
              · шаг {activity.step}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/50">
            {mm}:{ss}
          </span>
        </div>
        <div
          className="mt-1 flex min-w-0 items-center gap-1.5"
          aria-label={t("agent_indicator.poslednie_deystviya")}
        >
          {activity.steps.length === 0 ? (
            <span className="text-[10.5px] text-muted-foreground/45">
              пока без внешних действий
            </span>
          ) : (
            activity.steps.map((step, index) => (
              <div key={step.key} className="flex min-w-0 items-center gap-1.5">
                {index > 0 && (
                  <span className="shrink-0 text-[9px] text-muted-foreground/30">
                    →
                  </span>
                )}
                <span
                  className={cn(
                    "min-w-0 truncate text-[10.5px] transition-colors",
                    step.state === "running" && "font-medium text-foreground",
                    step.state === "done" && "text-foreground/70",
                    step.state === "error" && "text-red-400/80",
                  )}
                >
                  {step.state === "done"
                    ? "✓ "
                    : step.state === "error"
                      ? "⚠ "
                      : "● "}
                  {step.label}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default AgentIndicator;
