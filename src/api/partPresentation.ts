/**
 * Вид части сообщения: решение отдельно от разметки (I-33).
 *
 * Этап 3.2. До этого «что рисовать» жило внутри `PartView.tsx` тремя разными
 * способами сразу — множеством `HIDDEN_TYPES`, множеством `STEP_TYPES` и
 * `switch` по типу, — то есть решение видел только рендер. Ровно та же форма,
 * что у `capabilityGate` до вынесения и у решений точки входа на сервере:
 * проверить нельзя, потому что для проверки надо поднять компонент.
 *
 * Здесь нет ни React, ни разметки. Функция отвечает на один вопрос — каким
 * ВИДОМ показывается часть, — а как этот вид выглядит, решает компонент.
 *
 * Извлечение поведение НЕ меняет: набор видов и условия переписаны с
 * `PartView` один в один. Это сознательно: перенос решения и изменение
 * решения — две разные правки, и смешивать их значит лишиться возможности
 * сказать, которая из них что сломала.
 */

/**
 * Закрытый набор видов.
 *
 * Закрытость — не аккуратность, а требование: пока вид выводился `switch`-ем
 * внутри рендера, шестой вид мог появиться молча. Тип живёт только во время
 * сборки, поэтому набор дополнительно перечислен значением ниже и
 * проверяется перебором.
 */
export type PartPresentation =
  | "hidden"
  | "empty"
  | "step"
  | "attachment"
  | "file"
  | "text"
  | "reasoning"
  | "tool"
  | "fallback";

/** Тот же набор значением: перебрать тип во время выполнения нельзя. */
export const PART_PRESENTATIONS: readonly PartPresentation[] = Object.freeze([
  "hidden",
  "empty",
  "step",
  "attachment",
  "file",
  "text",
  "reasoning",
  "tool",
  "fallback",
]);

/** Типы, которые не показываются никогда. */
const HIDDEN_TYPES = new Set(["stub"]);

/** Служебные шаги: показываются приглушённо и только если есть текст. */
const STEP_TYPES = new Set(["step-start", "step-finish", "step-reasoning"]);

/** Виды, у которых показывать нечего, если текста нет. */
const TEXT_REQUIRED = new Set<PartPresentation>([
  "step",
  "text",
  "reasoning",
  "fallback",
]);

/**
 * Есть ли в части текст.
 *
 * Повторяет `asText` из `PartView`: объект превращается в JSON. Это НЕ
 * улучшение и не описка — так работает сегодня, и вынос решения не место для
 * смены поведения. Само по себе показывать пользователю JSON нехорошо, и это
 * названо отдельной строкой в `contracts/INVARIANTS.md` как известное
 * отклонение, а не спрятано здесь под видом нормы.
 */
function hasText(value: unknown): boolean {
  // Строка из одних пробелов текстом не считается. Это не расхождение с
  // `asText`, а следствие того же правила: показывать в такой части нечего.
  // Пока считалась, она рвала цепочку действий — «Действия» шли подряд
  // тремя блоками без единого слова между ними, потому что между ними
  // стояла часть, которая ничего не рисует.
  if (typeof value === "string") return value.trim().length > 0;
  if (value == null) return false;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).length > 2;
    } catch {
      return false;
    }
  }
  return String(value).length > 0;
}

/**
 * Каким видом показывается часть.
 *
 * Функция ТОТАЛЬНА: любой вход даёт значение из набора, и `undefined` она не
 * возвращает никогда. Это главное её свойство — «не знаю, что это» обязано
 * быть названо видом, а не отсутствием вида: часть, исчезнувшая молча, это
 * потерянный кусок ответа, и заметить его нечем.
 *
 * @param part часть сообщения в том виде, в каком её отдаёт движок
 */
export function presentationFor(part: unknown): PartPresentation {
  if (!part || typeof part !== "object") return "hidden";
  const p = part as { type?: unknown; text?: unknown };
  const type = typeof p.type === "string" ? p.type : "";

  if (HIDDEN_TYPES.has(type)) return "hidden";
  if (STEP_TYPES.has(type)) return hasText(p.text) ? "step" : "empty";

  switch (type) {
    case "attachment":
      return "attachment";
    case "file":
      return "file";
    case "text":
      return hasText(p.text) ? "text" : "empty";
    case "reasoning":
      return hasText(p.text) ? "reasoning" : "empty";
    case "tool":
      return "tool";
    default:
      // Незнакомый тип с текстом показывается как текст, а не теряется.
      // Движок волен завести новый вид части, и «ничего не показали» здесь
      // означало бы, что кусок ответа исчез, а никакой ошибки при этом нет.
      return hasText(p.text) ? "fallback" : "empty";
  }
}

/** Требует ли вид непустого текста. Используется тестами и компонентом. */
export function needsText(presentation: PartPresentation): boolean {
  return TEXT_REQUIRED.has(presentation);
}

/**
 * Показывается ли вид пользователю вообще.
 *
 * Два невидимых вида различаются намеренно. `hidden` — «показывать нечего и не
 * надо»; `empty` — «показывать было бы что, но содержимого нет». Слить их в
 * один значило бы потерять единственный признак, по которому видно, что часть
 * пришла пустой.
 */
export function isVisible(presentation: PartPresentation): boolean {
  return presentation !== "hidden" && presentation !== "empty";
}
