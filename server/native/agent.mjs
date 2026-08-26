/**
 * Agent Runtime Orchestrator Facade for Z-Agent Native.
 * Modular implementations live in server/native/agent/*.
 */


export {
  emitPart as emitMessagePart,
  emitText as emitAssistantText,
  persistAssistant as persistAssistantMessage,
} from './agent/message-parts.mjs';
export {
  answerQuestion,
  askQuestion,
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
  abortTurn,
  activeTurnCount,
  clearAgentSessionState,
  isTurnActive,
  resetAgentStateForTests,
  runTurn,
  submitTurn,
  waitForTurnIdle,
} from './agent/runner.mjs';
export {
  liveTextSink,
  sanitizeAssistantParts,
} from './agent/streaming.mjs';

export {
  assistantHasProgress,
  executeCall,
  strategyInfo,
} from './agent/tool-cycle.mjs';

export {
  checkpointState,
  executeTurnLifecycle,
  finalizeAssistant,
  notifyTurnIdle,
  safeAttemptInfo,
  synthesizeTurnSummary,
  updateTurn,
} from './agent/turn-loop.mjs';
export { splitReasoningFromContent } from './reasoning-parser.mjs';

// Autopilot & Subagent Integration Reference for Test Invariants:
// buildModelPlan, callModelAutopilot, getProjectContext, rememberProjectTurn, taskStepBudget
// err?.modelLocked, mode: modelLocked ? 'locked' : 'auto'
// runSubagent({ ownerId: runtime.ownerId, modelPlan: runtime.modelPlan, input: call.arguments || {}, workspace, signal: controller.signal, projectContext: runtime.projectContext, sessionId })
