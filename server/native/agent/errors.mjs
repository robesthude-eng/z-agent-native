export class AgentRuntimeError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'AgentRuntimeError';
    this.code = options.code ?? 'AGENT_RUNTIME_ERROR';
  }
}
export function wrapAgentError(error, code) {
  if (error instanceof AgentRuntimeError) return error;
  return new AgentRuntimeError(error?.message ?? String(error), { cause: error, code });
}
