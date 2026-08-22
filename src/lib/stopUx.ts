import type { Message } from "../api/types";

interface StopMarker {
  messageId?: string;
  requestedAt: number;
}

const PREFIX = "z-agent:stopped-message:";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Remember which visible assistant response the user stopped.
 *
 * The runtime persists a cancelled turn as a normal assistant message with
 * finish="stop", which is intentionally indistinguishable from a successful
 * model stop. Keeping this tiny UI marker lets the chat say
 * "Остановлено пользователем" without changing execution semantics. It lives
 * only for the browser tab and never becomes model context.
 */
export function markStopRequested(sessionId: string, messageId?: string): void {
  const s = storage();
  if (!s || !sessionId) return;
  const marker: StopMarker = {
    requestedAt: Date.now(),
    ...(messageId ? { messageId } : {}),
  };
  try {
    s.setItem(`${PREFIX}${sessionId}`, JSON.stringify(marker));
  } catch {
    // sessionStorage can be unavailable in privacy-restricted contexts.
  }
}

export function wasStoppedByUser(message: Message): boolean {
  const sid = message.sessionID || message.sessionId || message.session_id;
  const s = storage();
  if (!s || !sid) return false;
  try {
    const raw = s.getItem(`${PREFIX}${sid}`);
    if (!raw) return false;
    const marker = JSON.parse(raw) as StopMarker;
    if (marker.messageId) return marker.messageId === message.id;

    // Very fast Stop can happen before the assistant shell reaches the client.
    // Окно было 15 с — слишком широко: любой следующий короткий ход,
    // завершённый внутри него, получал ярлык «Остановлено пользователем»,
    // хотя агент закончил сам. Отмена доезжает до клиента за десятки-сотни
    // миллисекунд, поэтому 2.5 с достаточно; плюс маркер теперь снимается
    // при старте следующего хода (clearStopMarker).
    const completed = message.time?.completed ?? message.info?.time?.completed;
    return (
      typeof completed === "number" &&
      completed >= marker.requestedAt - 1000 &&
      completed <= marker.requestedAt + 2_500
    );
  } catch {
    return false;
  }
}

/**
 * Снять маркер «Стоп» сессии. Маркер жил до конца жизни таба и мог
 * прилипнуть к чужому ответу; новый ход — единственный момент, когда точно
 * известно, что прошлая остановка больше ни к чему не относится.
 */
export function clearStopMarker(sessionId: string): void {
  const s = storage();
  if (!s || !sessionId) return;
  try {
    s.removeItem(`${PREFIX}${sessionId}`);
  } catch {
    // sessionStorage can be unavailable in privacy-restricted contexts.
  }
}
