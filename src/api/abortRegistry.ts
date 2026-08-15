// Релиз 4: централизованная отмена HTTP-операций по сессии.
// Кнопка «Стоп» (sessionsSlice.abort) вызывает abortSessionRequests(sid) —
// обрывается долгоживущий promptWithParts этой сессии. Короткие запросы
// (поллер, doFinalFetch) сигнал не получают сознательно: именно они
// подтверждают финализацию ответа после остановки.
const controllers = new Map<string, AbortController>();

/** Сигнал отмены для сессии; после abort автоматически выдаётся свежий. */
export function sessionSignal(sessionId: string): AbortSignal {
  let c = controllers.get(sessionId);
  if (!c || c.signal.aborted) {
    c = new AbortController();
    controllers.set(sessionId, c);
  }
  return c.signal;
}

/** Оборвать все подписанные на сессию запросы (кнопка «Стоп»). */
export function abortSessionRequests(sessionId: string): void {
  const c = controllers.get(sessionId);
  if (!c) return;
  controllers.delete(sessionId);
  c.abort();
}

/** true, если ошибка — результат отмены запроса, а не сбой сети/сервера. */
export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException || e instanceof Error) && e.name === "AbortError"
  );
}
