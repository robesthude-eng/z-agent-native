export function createTurnContract(input = {}) {
  return {
    sessionId: input.sessionId ?? '',
    turnId: input.turnId ?? '',
    ownerId: input.ownerId ?? '',
  };
}
