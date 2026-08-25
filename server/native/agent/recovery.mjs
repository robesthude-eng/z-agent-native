export function createRecoveryContext(data = {}) {
  return { recoveredAt: Date.now(), ...data };
}
