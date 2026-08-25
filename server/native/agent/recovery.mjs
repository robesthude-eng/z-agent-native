/** Recovery boundary for durable jobs and interrupted turns. */
export function createRecoveryHandler({ recover }) {
  return async function recoverTurn(context) {
    return recover(context);
  };
}
