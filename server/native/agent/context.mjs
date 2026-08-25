export function createTurnContext(input = {}) {
  return {
    ...input,
    startedAt: input.startedAt ?? Date.now(),
    signal: input.signal ?? null,
  };
}
