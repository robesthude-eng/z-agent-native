import { useEffect, useRef, useState } from "react";
import { t, tf } from "@/i18n";
import type { AgentActivity } from "@/lib/agentActivity";
import { cn } from "@/lib/utils";

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
  /*
    Счётчик идёт от начала хода, а не от монтирования компонента. Раньше
    переключение вкладки или возврат в чат сбрасывали время на 0:00, и
    долгий ход выглядел только что начатым. Если времени старта нет
    (старые сообщения без time.created) — честный фолбэк на момент показа.
  */
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    /*
      В фоновой вкладке секундомер никто не видит, а интервал продолжал
      перерисовывать ленту раз в секунду весь длинный ход — это заметный
      расход батареи на ноутбуке. Интервал живёт только пока вкладка
      видима; при возврате время пересчитывается от startedAt, поэтому
      "догонять" пропущенные тики не нужно.
    */
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const startedAt = activity.startedAt ?? mountedAt.current;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="oc-thinking min-w-0">
      {/* Чистая декорация: аура и «>_» скринридеру ничего не говорят. */}
      <div className="oc-aura" aria-hidden="true">
        <div className="oc-aura-glow" />
        <div className="oc-aura-mark">&gt;_</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          {/*
            Живая область: без неё смена состояния агента была видна только
            глазами — скринридер молчал всё время работы. `polite`, чтобы не
            перебивать чтение, `atomic` — чтобы строка читалась целиком
            («Команда · npm test»), а не обрывками при смене одного слова.

            Секундомер оставлен СНАРУЖИ области сознательно: внутри он менялся
            бы раз в секунду, и вместо тишины между событиями скринридер
            зачитывал бы строку заново каждую секунду.
          */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex min-w-0 items-center gap-1.5"
          >
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
                · {tf("agent_indicator.shag_0", [activity.step])}
              </span>
            )}
          </div>
          <span
            aria-hidden="true"
            className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/50"
          >
            {mm}:{ss}
          </span>
        </div>
        {/*
          Трейл шагов скрыт от скринридера: то же самое уже объявила живая
          область выше, а повтор превращает озвучку в шум. Бывший здесь
          `aria-label` на обычном div всё равно не читался: у контейнера без
          роли имя игнорируется — это была видимость доступности, не доступность.
        */}
        <div
          className="mt-1 flex min-w-0 items-center gap-1.5"
          aria-hidden="true"
        >
          {activity.steps.length === 0 ? (
            <span className="text-[10.5px] text-muted-foreground/45">
              {t("agent_indicator.poka_bez_vneshnih_deystviy")}
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
