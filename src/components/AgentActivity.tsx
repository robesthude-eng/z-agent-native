import { ChevronRight, Wrench } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Сворачиваемая обёртка над цепочкой «действий» агента: подряд идущие
 * вызовы инструментов, размышления и служебные step-части.
 *
 * Поведение как у ReasoningCard/ToolGroup: пока цепочка выполняется —
 * блок раскрыт и виден прогресс в реальном времени; когда агент перешёл
 * к тексту или закончил — блок сворачивается в одну ghost-строку
 * «Действия · N шагов». Комментарии между цепочками и финальный отчёт
 * рендерятся снаружи и видны всегда.
 *
 * `manuallyToggled` перекрывает автологику: пользователь может раскрыть
 * завершённую цепочку или свернуть выполняющуюся — его выбор сохраняется.
 */

/** «1 шаг», «2 шага», «5 шагов» — русская плюрализация. */
function formatSteps(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 19) return `${n} шагов`;
  if (mod10 === 1) return `${n} шаг`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} шага`;
  return `${n} шагов`;
}

const AgentActivity = ({
  count,
  running,
  hasError,
  children,
}: {
  /** Число шагов внутри (вызовы инструментов + размышления). */
  count: number;
  /** Цепочка ещё выполняется — держим блок раскрытым. */
  running: boolean;
  /** Внутри есть упавший инструмент — показываем маркер и в свёрнутом виде. */
  hasError: boolean;
  children: ReactNode;
}) => {
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  const expanded = manuallyToggled ?? running;

  return (
    <div className="not-prose my-1">
      <button
        type="button"
        aria-expanded={expanded}
        className="group/activity flex w-full items-center gap-2 px-2 py-1.5 text-left rounded-lg hover:bg-accent/30 transition cursor-pointer"
        // Один клик переключает относительно видимого состояния
        // (тот же фикс двойного клика, что в ReasoningCard/ToolGroup).
        onClick={() => setManuallyToggled(!expanded)}
      >
        <span className="text-muted-foreground/50 shrink-0">
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </span>
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground",
            running && "animate-pulse text-foreground",
          )}
        >
          <Wrench className="h-[15px] w-[15px]" />
        </span>
        <span className="text-[13px] font-medium text-foreground/85">
          {running ? "Выполняет действия" : "Действия"}
        </span>
        <span className="text-[11.5px] text-muted-foreground/70">
          {formatSteps(count)}
        </span>
        {running && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse" />
        )}
        {!running && hasError && (
          <span className="text-[11px] font-medium text-red-400">error</span>
        )}
        <span className="flex-1" />
      </button>
      {/* Раскрытая цепочка: лёгкая направляющая слева, как у вложенных блоков. */}
      {expanded && (
        <div className="oc-card-open ml-[9px] border-l border-border/60 pl-3 space-y-0.5">
          {children}
        </div>
      )}
    </div>
  );
};

export default memo(AgentActivity);
