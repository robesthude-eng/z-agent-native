import type { CSSProperties } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Круговой «думающий» лоадер.
 *
 * Форма взята с ai-loader (21st.dev, @theutkarshmail): два встречно вращающихся
 * кольца и пульсирующее ядро — движение читается как «идёт мысль», а не как
 * «страница зависла». Реализация своя: компонент из галереи тянет за собой
 * framer-motion и свою палитру, а здесь всё держится на CSS-классах `oc-ai-loader*`
 * из `src/index.css`, то есть на токенах темы: лоадер одинаково уместен на
 * светлой и тёмной теме и не добавляет ни одной зависимости.
 *
 * При `prefers-reduced-motion` вращение выключается — там же, в CSS.
 */
export function AiLoader({
  size = 30,
  className,
  label,
  tone = "default",
}: {
  /** Внешний диаметр в пикселях. */
  size?: number;
  className?: string;
  /** Подпись для скринридера. По умолчанию — «Агент работает». */
  label?: string;
  /** `muted` — приглушённый вариант для плотных мест вроде строки инструмента. */
  tone?: "default" | "muted";
}) {
  return (
    <span
      role="status"
      aria-label={label ?? t("ai_loader.agent_rabotaet")}
      className={cn(
        "oc-ai-loader",
        tone === "muted" && "oc-ai-loader--muted",
        className,
      )}
      style={{ "--oc-ai-size": `${size}px` } as CSSProperties}
    >
      <span className="oc-ai-loader-ring" />
      <span className="oc-ai-loader-ring oc-ai-loader-ring--inner" />
      <span className="oc-ai-loader-core" />
    </span>
  );
}

export default AiLoader;
