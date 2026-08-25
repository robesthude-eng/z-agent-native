// Runtime state isolated from orchestration code.
// The agent runner owns lifecycle; this module only owns in-memory coordination.
export const activeTurns = new Map();
export const activeActions = new Map();
export const questionWaiters = new Map();
export const idleWaiters = new Map();

export const MAX_ACTIVE_TURNS = Math.min(Math.max(Number(process.env.Z_AGENT_MAX_ACTIVE_TURNS) || 32, 1), 256);
export const MAX_ACTIVE_TURNS_PER_OWNER = Math.min(Math.max(Number(process.env.Z_AGENT_MAX_ACTIVE_TURNS_PER_OWNER) || 4, 1), MAX_ACTIVE_TURNS);
export const TURN_CAPACITY_TTL_MS = Math.min(Math.max(Number(process.env.Z_AGENT_TURN_CAPACITY_TTL_MS) || 120_000, 30_000), 30 * 60 * 1000);

export function resetRuntimeState() {
  activeTurns.clear();
  activeActions.clear();
  questionWaiters.clear();
  idleWaiters.clear();
}
