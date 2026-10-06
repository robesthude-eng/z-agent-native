import { useEffect, useRef, useState } from "react";

/**
 * Плавный вывод стримящегося текста.
 *
 * ВЫКЛЮЧЕНО по умолчанию (`smooth: true` включает). Анимация догоняла текст
 * на 140–900 мс позади того, что уже пришло с сервера, а пользователь хочет
 * видеть вывод агента в прямом эфире, без искусственной задержки. Дельты
 * и так батчатся раз в кадр (см. eventHandlers), этого достаточно для
 * плавности.
 *
 * Провайдеры присылают текст пачками неравномерно: то несколько символов
 * подряд, то крупный кусок раз в секунду. Хук показывает текст с темпом,
 * подстроенным под средний интервал между пачками, — чтобы очередная пачка
 * «допечатывалась» примерно к приходу следующей, без рывков и пауз.
 *
 * - Шаг доводится до конца слова: полуслова не мелькают.
 * - Когда стрим закончился, остаток быстро допечатывается, а не появляется
 *   скачком.
 * - Когда отставания нет, rAF останавливается и не тратит CPU.
 * - При prefers-reduced-motion текст показывается сразу.
 */
export function useSmoothStreamingText(
  text: string,
  streaming: boolean,
  opts?: {
    /** Минимальное и максимальное время догонки отставания, мс. */
    minCatchUpMs?: number;
    maxCatchUpMs?: number;
    /** Время допечатки остатка после окончания стрима, мс. */
    drainMs?: number;
    frameMs?: number;
    hardLimit?: number;
    /** Включить анимацию догонки (по умолчанию текст показывается сразу). */
    smooth?: boolean;
  },
): string {
  const minCatchUpMs = opts?.minCatchUpMs ?? 140;
  const maxCatchUpMs = opts?.maxCatchUpMs ?? 900;
  const drainMs = opts?.drainMs ?? 260;
  const frameMs = opts?.frameMs ?? 16;
  const hardLimit = opts?.hardLimit ?? 40000;
  const smooth = opts?.smooth === true;

  const [shown, setShown] = useState(text);
  const [animating, setAnimating] = useState(false);
  const targetRef = useRef(text);
  const lenRef = useRef(text.length);
  const posRef = useRef(text.length);
  const rafRef = useRef(0);
  const streamingRef = useRef(streaming);
  const wasStreamingRef = useRef(streaming);
  const lastArrivalRef = useRef(0);
  const intervalEmaRef = useRef(0);
  const [reducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const prev = targetRef.current;
    targetRef.current = text;
    streamingRef.current = streaming;
    if (streaming) wasStreamingRef.current = true;

    const stop = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    const finish = () => {
      stop();
      lenRef.current = text.length;
      posRef.current = text.length;
      setShown(text);
      setAnimating(false);
    };

    // История, редактирование, сброс текста, огромные ответы — без анимации.
    if (
      !smooth ||
      reducedMotion ||
      (!streaming && !wasStreamingRef.current) ||
      !text.startsWith(prev.slice(0, lenRef.current)) ||
      text.length > hardLimit
    ) {
      finish();
      return;
    }

    const now = performance.now();
    if (streaming && text.length > prev.length) {
      if (lastArrivalRef.current) {
        const gap = Math.min(2000, now - lastArrivalRef.current);
        intervalEmaRef.current = intervalEmaRef.current
          ? intervalEmaRef.current * 0.7 + gap * 0.3
          : gap;
      }
      lastArrivalRef.current = now;
    }

    if (lenRef.current >= text.length) {
      if (!streaming) {
        wasStreamingRef.current = false;
        finish();
      }
      return;
    }
    if (rafRef.current) return; // уже идёт — новая цель подхватится из ref
    setAnimating(true);

    let last = performance.now();
    const tick = (t: number) => {
      const target = targetRef.current;
      const dt = t - last;
      if (dt >= frameMs) {
        last = t;
        const backlog = target.length - lenRef.current;
        if (backlog <= 0) {
          rafRef.current = 0;
          if (!streamingRef.current) {
            wasStreamingRef.current = false;
            setAnimating(false);
          }
          return;
        }
        const catchUp = streamingRef.current
          ? Math.min(
              maxCatchUpMs,
              Math.max(minCatchUpMs, intervalEmaRef.current * 1.15),
            )
          : drainMs;
        // Длинный текст — Markdown дороже, шаги реже, но крупнее.
        const effectiveDt = target.length > 12000 ? Math.max(dt, 48) : dt;
        // Позиция дробная: за кадр может набежать меньше символа.
        const pending = target.length - posRef.current;
        posRef.current = Math.min(
          target.length,
          posRef.current + Math.max(0.35, (pending * effectiveDt) / catchUp),
        );
        // Показываем до конца последнего целого слова; длинные «слова»
        // (ссылки, код) — посимвольно.
        let next = Math.floor(posRef.current);
        if (next < target.length) {
          let k = next;
          while (k > lenRef.current && !/\s/.test(target[k] ?? "")) k--;
          if (k > lenRef.current) next = k;
          else if (next - lenRef.current < 12) next = lenRef.current;
        }
        if (next > lenRef.current) {
          lenRef.current = next;
          setShown(target.slice(0, next));
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [
    text,
    streaming,
    smooth,
    reducedMotion,
    hardLimit,
    minCatchUpMs,
    maxCatchUpMs,
    drainMs,
    frameMs,
  ]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return smooth && (streaming || animating) && !reducedMotion ? shown : text;
}
