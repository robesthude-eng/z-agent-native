export async function runTurnLoop(step, state) {
  let current = state;
  while (true) {
    const result = await step(current);
    if (!result?.continue) return result;
    current = result.state ?? current;
  }
}
