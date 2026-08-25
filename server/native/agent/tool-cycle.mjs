/** Tool execution cycle boundary for agent runtime extraction. */
export function createToolCycle({ executeToolCall }) {
  return async function runToolCycle(context) {
    return executeToolCall(context);
  };
}
