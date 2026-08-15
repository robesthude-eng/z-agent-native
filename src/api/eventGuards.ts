// Релиз 5: рукописные type guards для SSE-пейлоадов — без zod и новых
// зависимостей. Заменяют небезопасные `as unknown as` касты: каждое
// обращение к динамическому полю проходит через рантайм-проверку.
import type { AppEvent } from "./types";

/** Значение — объект (record)? */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Строковое поле динамического объекта (part.sessionID, message.id …).
 * undefined — если объект не объект или поле не строка.
 */
export function strField(v: unknown, key: string): string | undefined {
  if (!isRecord(v)) return undefined;
  const value = v[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Идентификаторы из пейлоада события — слой совместимости с движком.
 *
 * Три цепочки ниже выглядят избыточно, но каждая ветка отвечает конкретной
 * вариантах payload: поле переезжает между `sessionID`/`session_id`/`sessionId`
 * и между корнем события и вложенными `part`/`info`/`message`. Пока цепочки
 * стояли развёрнутыми внутри `applyEvent`, они были продублированы трижды в
 * слегка разных вариантах — а промах любой из них выглядит не как ошибка, а
 * как молча пропущенное событие: сообщение не появляется, дельта теряется,
 * ход не закрывается.
 */

/** Значение первого поля из списка, которое оказалось непустой строкой. */
function firstString(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Идентификатор сессии события.
 *
 * Сначала корень пейлоада, затем вложенные объекты: у части событий движок
 * кладёт сессию только внутрь `part`/`info`/`message`.
 *
 * @returns id либо пустая строка — вызывающий обязан на неё проверить.
 */
export function eventSessionId(p: unknown): string {
  if (!isRecord(p)) return "";
  return (
    firstString(p, ["sessionID", "session_id", "sessionId"]) ||
    strField(p.part, "sessionID") ||
    strField(p.info, "sessionID") ||
    strField(p.message, "sessionID") ||
    ""
  );
}

/**
 * Идентификатор сообщения.
 *
 * @param nested где искать после корня: `"part"` для частей и дельт,
 *   `"message"` для удаления сообщения. Разные события кладут его по-разному,
 *   и объединять эти списки нельзя — `part.messageID` у события об удалении
 *   сообщения означал бы чужой идентификатор.
 */
export function eventMessageId(
  p: unknown,
  nested: "part" | "message" = "part",
): string {
  if (!isRecord(p)) return "";
  const root = firstString(p, ["messageID", "message_id", "messageId"]);
  if (root) return root;
  if (nested === "message") return strField(p.message, "id") || "";
  return strField(p.part, "messageID") || strField(p.part, "message_id") || "";
}

/** Идентификатор части сообщения (только дельты). */
export function eventPartId(p: unknown): string {
  if (!isRecord(p)) return "";
  return (
    firstString(p, ["partID", "part_id", "partId"]) ||
    strField(p.part, "id") ||
    ""
  );
}

/** Кадр из стрима структурно похож на AppEvent ({ type, properties })? */
export function isAppEventShaped(v: unknown): v is AppEvent {
  return isRecord(v) && typeof v.type === "string" && isRecord(v.properties);
}

/**
 * Статус сессии приходит строкой ("busy") или объектом ({ type: "busy" })
 * в некоторых потоковых payload — нормализуем к строке.
 */
export function statusText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return strField(raw, "type") || "idle";
}

/**
 * Человекочитаемое сообщение об ошибке из динамических форм:
 * "text" | { message: string } | { data: { message: string } }.
 * Заменяет as any-касты в MessageItem/ToolCard.
 */
export function errorMessage(err: unknown): string | undefined {
  if (typeof err === "string") return err;
  const direct = strField(err, "message");
  if (direct) return direct;
  if (isRecord(err)) return strField(err.data, "message");
  return undefined;
}

/**
 * Прерывание, а не поломка.
 *
 * `MessageAborted` остаётся нормальным исходом пользовательской кнопки «Стоп».
 * Для совместимости здесь также не красим старые сообщения-вопросы, созданные
 * прежним клиентом, который отвечал через abort. Новый Question API такой
 * ошибки при выборе варианта больше не создаёт.
 *
 * Опознаётся по имени класса ошибки; текст проверяется вторым, потому что
 * форма поля у движка от версии к версии плавает.
 */
const ABORT_MARK = /abort|прерван/i;

/** @param err значение поля `info.error` сообщения */
export function isAbortedError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === "string") return ABORT_MARK.test(err);
  if (!isRecord(err)) return false;
  const name = strField(err, "name") ?? strField(err.data, "name") ?? "";
  if (ABORT_MARK.test(name)) return true;
  return ABORT_MARK.test(errorMessage(err) ?? "");
}
