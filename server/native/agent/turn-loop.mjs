/**
 * Agent turn-loop boundary.
 * Kept dependency free so orchestration can move here incrementally.
 */
export function createTurnLoop({ execute }) {
  return async function runTurnLoop(context) {
    return execute(context);
  };
}
