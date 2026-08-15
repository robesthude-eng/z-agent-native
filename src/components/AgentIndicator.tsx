import { useEffect, useState } from "react";

/**
 * Индикатор работы агента: «дышащая» аура вокруг знака >_,
 * переливающийся текст текущей фазы, опциональная мета-подпись
 * (например «шаг 4») и таймер с начала работы — как в эталонном мокапе.
 * Стили — в src/index.css (блок «agent work indicator»).
 */
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
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="oc-thinking">
      <div className="oc-aura">
        <div className="oc-aura-glow" />
        <div className="oc-aura-mark">&gt;_</div>
      </div>
      <span className="oc-sheen-text">{label}</span>
      {meta && (
        <span className="font-mono text-[11px] text-muted-foreground/70">
          · {meta}
        </span>
      )}
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground/50">
        {mm}:{ss}
      </span>
    </div>
  );
}

export default AgentIndicator;
