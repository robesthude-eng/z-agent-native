export class ToolExecutionError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ToolExecutionError';
    this.tool = options.tool;
  }
}

export function wrapToolError(error, tool) {
  if (error instanceof ToolExecutionError) return error;
  return new ToolExecutionError(error?.message || String(error), {
    cause: error,
    tool,
  });
}
