/**
 * Повтор отправки промпта: когда он спасает, а когда создаёт дубликат.
 *
 * Решение вынесено из `send()` в `messagesSlice.ts`, где оно жило внутри
 * пятисотстрочного метода и потому не проверялось ничем. Цена ошибки тут
 * известна заранее и уже была заплачена: слепой повтор отправлял ВТОРОЙ
 * промпт, в чате сам собой появлялся второй user-message, движок прерывал
 * текущий ход и начинал обрабатывать дубль — снаружи это выглядело как
 * «агент остановился → пришло сообщение → продолжил».
 */

/** Порог, после которого обрыв означает «промпт уже на сервере». */
export const PROMPT_DELIVERED_MS = 8_000;

/** Пауза перед повтором — даём серверу и сети восстановиться. */
export const PROMPT_RETRY_PAUSE_MS = 800;

/**
 * Похожа ли ошибка на сетевую или временную серверную.
 *
 * Список текстов, а не кодов, потому что источники разные и кода у половины
 * из них нет: Chrome говорит «Failed to fetch», Firefox — «NetworkError…»,
 * Safari — «Load failed», Node — «socket hang up»/«ECONNRESET», сервер —
 * 503/unavailable/timed out. Совпадение по подстроке в нижнем регистре —
 * единственное, что объединяет их все.
 */
export function isNetworkishError(message: string): boolean {
  const msg = (message || "").toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("timed out") ||
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset")
  );
}

/**
 * Что делать с неудавшейся попыткой отправки промпта.
 *
 * - `deliveered` здесь нет: `assume-delivered` означает «повтор ЗАПРЕЩЁН».
 *   POST /message висит открытым весь ход агента — на длинной задаче это
 *   минуты, и такое соединение убивают edge-прокси или мобильная сеть. Если
 *   запрос прожил дольше `PROMPT_DELIVERED_MS` и умер, промпт уже на сервере
 *   и ход идёт: ждём финал через SSE `session.idle` или HTTP-поллер.
 * - `retry` — ранний сетевой сбой, до доставки: повторяем с тем же ключом
 *   идемпотентности.
 * - `fail` — ошибка не сетевая (её повтор не починит) либо попытки кончились.
 *
 * Native runtime всегда ведёт реестр действий. Порог остаётся дополнительной
 * оптимизацией: поздний сетевой обрыв не заставляет браузер повторно держать
 * ещё одно длинное соединение, а одинаковый actionId в любом случае защищает
 * от второго turn.
 */
export type PromptRetryVerdict = "retry" | "assume-delivered" | "fail";

export function promptRetryDecision(facts: {
  /** Текст ошибки попытки. */
  message: string;
  /** Сколько прожила попытка до ошибки, мс. */
  elapsedMs: number;
  /** Номер попытки, с нуля. */
  attempt: number;
  /** Сколько повторов разрешено сверх первой попытки. */
  retries: number;
}): PromptRetryVerdict {
  const networkish = isNetworkishError(facts.message);
  // Порядок проверок — часть решения. «Доставлено» стоит ПЕРВЫМ среди
  // сетевых исходов: поздний обрыв нельзя повторять, даже если попытки ещё
  // остались, — именно перестановка этих двух шагов и рождала дубликаты.
  if (networkish && facts.elapsedMs >= PROMPT_DELIVERED_MS) {
    return "assume-delivered";
  }
  if (!networkish || facts.attempt >= facts.retries) return "fail";
  return "retry";
}
