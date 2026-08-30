import { useEffect, useRef, useState } from "react";

/**
 * Плавный «typewriter»-стрим без утечек rAF.
 * Когда отставание догнано (`lenRef.current === target.length`), rAF останавливается
 * и ждёт поступления новых символов, не нагружая CPU.
 */
export function useSmoothStreamingText(
  text: string,
  streaming: boolean,
  opts?: {
    catchUpMs?: number;
    minStep?: number;
    frameMs?: number;
    hardLimit?: number;
  },
): string {
  const catchUpMs = opts?.catchUpMs ?? 320;
  const minStep = opts?.minStep ?? 2;
  const frameMs = opts?.frameMs ?? 33;
  const hardLimit = opts?.hardLimit ?? 24000;

  const [shown, setShown] = useState(text);
  const targetRef = useRef(text);
  const lenRef = useRef(text.length);
  const rafRef = useRef<number>(0);
  /*
    «Печатающий» вывод — это анимация. При prefers-reduced-motion её быть не
    должно: текст появляется сразу и целиком.
  */
  const [reducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    // Цель обновляем в эффекте, а не в теле рендера: присваивание при
    // рендере — побочный эффект, и в конкурентном режиме оно может
    // произойти для кадра, который так и не покажут.
    targetRef.current = text;

    if (!streaming || reducedMotion) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lenRef.current = targetRef.current.length;
      setShown(targetRef.current);
      return;
    }

    // Сравниваем именно с `text`, а не с targetRef.current: приход нового чанка
    // (смена text) — единственное, что перезапускает эффект и «будит» rAF,
    // остановленный после догонки. Через ref зависимость выглядела бы лишней,
    // и автофикс линтера выкинул бы text из deps — стрим замер бы навсегда.
    if (lenRef.current === text.length) {
      return;
    }

    let last = performance.now();
    const tick = (now: number) => {
      const target = targetRef.current;
      /*
        Каждый шаг перерисовывает Markdown целиком. На коротком ответе это
        дёшево, и 30 шагов в секунду выглядят как печать; на длинном разбор
        занимает почти весь кадр — лента дёргается вместо плавного хода.
        Поэтому чем длиннее текст, тем реже шаг.
      */
      const interval = target.length > 8000 ? Math.max(frameMs, 66) : frameMs;
      if (now - last >= interval) {
        const dt = now - last;
        last = now;

        if (target.length > hardLimit || lenRef.current > target.length) {
          lenRef.current = target.length;
          setShown(target);
          rafRef.current = 0;
          return;
        }

        if (lenRef.current < target.length) {
          const backlog = target.length - lenRef.current;
          const step = Math.max(minStep, Math.ceil((backlog * dt) / catchUpMs));
          lenRef.current = Math.min(target.length, lenRef.current + step);
          setShown(target.slice(0, lenRef.current));
        }

        if (lenRef.current === target.length) {
          rafRef.current = 0;
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [streaming, text, catchUpMs, minStep, frameMs, hardLimit, reducedMotion]);

  return streaming && !reducedMotion ? shown : text;
}
