// Dispatcher extraction target.
// Runtime routing will be moved here from tools.mjs after compatibility checks.

export async function dispatchTool(name, input, context) {
  throw new Error(`Tool dispatcher migration pending: ${name}`);
}
