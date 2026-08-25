/** Completion/finalization boundary for agent runtime extraction. */
export function createCompletionHandler({ finalize }) {
  return async function complete(context) {
    return finalize(context);
  };
}
