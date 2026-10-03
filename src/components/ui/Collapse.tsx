import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Плавное раскрытие/сворачивание по высоте.
 *
 * Высота анимируется через `grid-template-rows: 0fr → 1fr`: так не нужно
 * мерить содержимое, и анимация остаётся на компоновщике браузера.
 * Содержимое монтируется только при раскрытии и размонтируется после
 * окончания сворачивания — длинный чат не держит в DOM вывод всех карточек.
 */
const DURATION_MS = 260;

export function Collapse({
  open,
  children,
  className,
  innerClassName,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const raf = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (open) {
      setMounted(true);
      // Два кадра: первый монтирует свёрнутое состояние, второй запускает переход.
      raf.current = requestAnimationFrame(() => {
        raf.current = requestAnimationFrame(() => setShown(true));
      });
      return () => cancelAnimationFrame(raf.current);
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), DURATION_MS + 40);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={cn("oc-collapse", className)}
      data-open={shown ? "true" : "false"}
      aria-hidden={!open}
    >
      <div className={cn("oc-collapse-inner", innerClassName)}>{children}</div>
    </div>
  );
}

export default Collapse;
