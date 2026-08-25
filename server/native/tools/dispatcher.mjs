import { getTool } from './registry.mjs';

/**
 * Central tool dispatch boundary.
 * Tool modules should register handlers here instead of growing tools.mjs.
 */
export async function dispatchTool(name, input, context) {
  const handler = getTool(name);

  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return handler(input, context);
}
