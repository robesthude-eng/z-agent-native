import { useEffect, useRef, useState } from "react";

type Hint = { text: string; x: number; y: number };

const LONG_PRESS_MS = 420;

/**
 * Подсказки для сенсорного экрана.
 *
 * Атрибут `title` показывается только при наведении курсором, а на
 * телефоне наведения не существует: десятки иконочных кнопок остаются
 * без единого объяснения. Компонент вешает один глобальный слушатель и
 * показывает подпись по долгому нажатию — без правок в каждой кнопке.
 *
 * Текст берётся из `title`, а если его нет — из `aria-label`, поэтому
 * сенсорный пользователь видит ровно то же, что читает скринридер.
 */
export function TouchHints() {
  const [hint, setHint] = useState<Hint | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    // Только сенсорные экраны: на десктопе работает родной tooltip браузера,
    // и вторая подсказка поверх неё только мешала бы.
    if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
      return;
    }

    let timer: number | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const start = event.target as Element | null;
      const target = start?.closest?.(
        "[title],[aria-label]",
      ) as HTMLElement | null;
      if (!target) return;
      const text = (
        target.getAttribute("title") ||
        target.getAttribute("aria-label") ||
        ""
      ).trim();
      if (!text) return;
      clearTimer();
      timer = window.setTimeout(() => {
        const rect = target.getBoundingClientRect();
        // Нажатие было долгим — это запрос подсказки, а не нажатие кнопки.
        // Без этого флага отпускание пальца выполнило бы действие.
        suppressClickRef.current = true;
        setHint({ text, x: rect.left + rect.width / 2, y: rect.top });
      }, LONG_PRESS_MS);
    };

    const dismiss = () => {
      clearTimer();
      setHint(null);
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", dismiss, { passive: true });
    window.addEventListener("pointercancel", dismiss, { passive: true });
    window.addEventListener("scroll", dismiss, {
      passive: true,
      capture: true,
    });
    window.addEventListener("click", onClickCapture, { capture: true });

    return () => {
      clearTimer();
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", dismiss);
      window.removeEventListener("pointercancel", dismiss);
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("click", onClickCapture, { capture: true });
    };
  }, []);

  if (!hint) return null;

  const viewportWidth = typeof window === "undefined" ? 360 : window.innerWidth;
  const style = {
    top: Math.max(8, hint.y - 44),
    left: Math.min(Math.max(72, hint.x), Math.max(72, viewportWidth - 72)),
  };

  return (
    <div
      role="tooltip"
      style={style}
      className="pointer-events-none fixed z-[100] max-w-[70vw] -translate-x-1/2 rounded-lg bg-foreground/95 px-3 py-1.5 text-center text-xs font-medium text-background shadow-lg"
    >
      {hint.text}
    </div>
  );
}
