// Tool execution boundary extracted for incremental migration.
export async function executeToolCycle(execute, calls) {
  const results = [];
  for (const call of calls ?? []) results.push(await execute(call));
  return results;
}
