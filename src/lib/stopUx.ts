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
    // In that case bind the marker to the response completed around the click,
    // but only inside a narrow window so a later turn is never mislabeled.
    const completed = message.time?.completed ?? message.info?.time?.completed;
    return (
      typeof completed === "number" &&
      completed >= marker.requestedAt - 1000 &&
      completed <= marker.requestedAt + 15_000
    );
  } catch {
    return false;
  }
}
