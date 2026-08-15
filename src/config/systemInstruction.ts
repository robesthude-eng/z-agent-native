/**
 * Z Agent Native owns its system policy on the server.
 * The browser never receives or round-trips the agent system prompt.
 */
export function getSystemInstruction(): Promise<string> {
  return Promise.resolve("");
}
export function resetSystemInstructionCache(): void {}
