export function createCompletionResult(data = {}) {
  return { completedAt: Date.now(), ...data };
}
