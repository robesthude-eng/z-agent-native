/**
 * Единственное место, где читается статус вызова инструмента.
 *
 * Раньше статус разбирали семь раз: в `messageFlow`, `turnFinality`,
 * `messageMerge`, `turnSummary`, `ToolGroup`, `toolCardUtils` и `agentActivity`.
 * Наборы значений расходились: где-то `pending` считался работой, где-то нет;
 * `success` в одном месте означал «готово», в другом не значил ничего. Один и тот
 * же вызов мог быть «работает» в шапке цепочки и «готово» в карточке под ней.
 *
 * Здесь два уровня, и оба нужны:
 *
 * - `rawToolStatus` — сырое значение без домыслов. Нужен там, где важно
 *   отличать «статуса нет» от «статус есть»: финализация хода не должна
 *   считать часть без статуса работающей, иначе интерфейс не отпустит никогда.
 * - `toolPhase` — нормализованная фаза для показа. Отсутствие статуса здесь
 *   разрешается наличием вывода: результат пришёл — вызов завершён.
 */

export type ToolPhase = "running" | "completed" | "error";

interface LooseToolPart {
  state?: unknown;
  output?: unknown;
}

/** Сырой статус: `state` приходит и строкой, и объектом `{ status }`. */
export function rawToolStatus(part: unknown): string | undefined {
  const state = (part as LooseToolPart | null | undefined)?.state;
  if (typeof state === "string") return state;
  if (state && typeof state === "object") {
    const status = (state as { status?: unknown }).status;
    return typeof status === "string" ? status : undefined;
  }
  return undefined;
}

const ERROR_STATUSES = new Set(["error", "failed"]);
const DONE_STATUSES = new Set(["completed", "done", "success"]);
const RUNNING_STATUSES = new Set(["running", "pending", "waiting"]);

/** Явная работа: только `running`/`pending`/`waiting`, без догадок. */
export function isRunningStatus(status: string | undefined): boolean {
  return status !== undefined && RUNNING_STATUSES.has(status);
}

export function isErrorStatus(status: string | undefined): boolean {
  return status !== undefined && ERROR_STATUSES.has(status);
}

export function isDoneStatus(status: string | undefined): boolean {
  return status !== undefined && DONE_STATUSES.has(status);
}

/**
 * Фаза вызова для показа в ленте.
 *
 * Неизвестный статус трактуется по выводу, а не как ошибка: движок волен
 * добавить своё значение, и интерфейс от этого не должен краснеть.
 */
export function toolPhase(part: unknown): ToolPhase {
  const status = rawToolStatus(part);
  if (isErrorStatus(status)) return "error";
  if (isDoneStatus(status)) return "completed";
  if (isRunningStatus(status)) return "running";
  const output = (part as LooseToolPart | null | undefined)?.output;
  return output != null ? "completed" : "running";
}
