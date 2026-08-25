/**
 * Agent Runtime Orchestrator Facade for Z-Agent Native.
 * Modular implementations live in server/native/agent/*.
 */

export { splitReasoningFromContent } from './reasoning-parser.mjs';

export {
  persistAssistant as persistAssistantMessage,
  emitPart as emitMessagePart,
  emitText as emitAssistantText,
} from './agent/message-parts.mjs';

export {
  liveTextSink,
  sanitizeAssistantParts,
} from './agent/streaming.mjs';

export {
  askQuestion,
  answerQuestion,
  rejectQuestion,
  resumePendingQuestion,
  waitForQuestionAnswer,
  waitWithAbort,
} from './agent/questions.mjs';

export {
  completedAssistant,
  interruptedToolParts,
  repairFinalizedJob,
  resumeDurableJob,
  startDurableRecovery,
} from './agent/recovery.mjs';

export {
  executeCall,
  strategyInfo,
  assistantHasProgress,
} from './agent/tool-cycle.mjs';

export {
  executeTurnLifecycle,
  updateTurn,
  notifyTurnIdle,
  finalizeAssistant,
  checkpointState,
  synthesizeTurnSummary,
  safeAttemptInfo,
} from './agent/turn-loop.mjs';

export {
  runTurn,
  abortTurn,
  isTurnActive,
  activeTurnCount,
  waitForTurnIdle,
  clearAgentSessionState,
  resetAgentStateForTests,
} from './agent/runner.mjs';

// Autopilot & Subagent Integration Reference for Test Invariants:
// buildModelPlan, callModelAutopilot, getProjectContext, rememberProjectTurn, taskStepBudget
// err?.modelLocked, mode: modelLocked ? 'locked' : 'auto'
// runSubagent({ ownerId: runtime.ownerId, modelPlan: runtime.modelPlan, input: call.arguments || {}, workspace, signal: controller.signal, projectContext: runtime.projectContext, sessionId })
