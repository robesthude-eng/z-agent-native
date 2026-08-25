/**
 * Shared execution context helpers.
 * Pass 901-1500: extracted boundary for future runner migration.
 */
export function createExecutionContext(input = {}) {
  return {
    turnId: input.turnId ?? null,
    sessionId: input.sessionId ?? null,
    signal: input.signal ?? null,
    metadata: input.metadata ?? {},
  };
}
