export const ID_PREFIX = {
  TMP: "tmp_",
  LOCAL: "local_",
  SESSION: "ses_",
  MESSAGE: "msg_",
  ACTION: "act_",
} as const;

/**
 * Ключ идемпотентности действия (OWNERSHIP_AND_DURABILITY §4).
 *
 * Вызывается ОДИН раз в момент создания действия — не при отправке. Повтор
 * отправки обязан использовать тот же идентификатор, иначе сервер увидит два
 * разных действия и создаст второй ход: ровно тот фантомный дубликат, ради
 * которого реестр и заведён (I-12).
 *
 * Форма подчинена серверной проверке `[A-Za-z0-9_-]{8,128}`: идентификатор
 * попадает в SQL как параметр и в логи как текст.
 */
export function newActionId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : // Фолбэк для окружений без Web Crypto (старый WebView, http-хост в
        // разработке). Уникальности внутри одного клиента достаточно: ключ
        // сверяется в паре с сессией и отпечатком тела.
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${ID_PREFIX.ACTION}${uuid}`;
}

export function isActionId(id?: string | null): id is string {
  return typeof id === "string" && id.startsWith(ID_PREFIX.ACTION);
}

export function isTmpSession(id?: string | null): id is string {
  return typeof id === "string" && id.startsWith(ID_PREFIX.TMP);
}

/**
 * Prepare a client session for an action. Native persisted sessions always use
 * the `ses_` prefix; optimistic drafts use `tmp_`. Unknown ids are not trusted.
 */
export function sessionActionPrep(
  currentId?: string | null,
): "ready" | "materialize" | "create" {
  if (!currentId) return "create";
  if (isTmpSession(currentId)) return "materialize";
  return isSessionId(currentId) ? "ready" : "create";
}

export function isLocalMessage(id?: string | null): id is string {
  return typeof id === "string" && id.startsWith(ID_PREFIX.LOCAL);
}

export function isSessionId(id?: string | null): id is string {
  return typeof id === "string" && id.startsWith(ID_PREFIX.SESSION);
}
