/**
 * Interruption and Question Protocol Facade for Z-Agent Native.
 * Modular implementations live in src/api/interruptions/*.
 */

export {
  activeQuestion,
  answerFromFeed,
  BAR_COLLAPSE_LINES,
  barPresentation,
  barWarning,
  feedTrace,
  hasQuestionPart,
  isBarQuestionPart,
  isInterruptedQuestionPart,
  isInterruptionBarEnabled,
  isLongForBar,
  optionsLayout,
  questionFeedLine,
  replyTextAfterCall,
  replyWarning,
} from "./interruptions/feed";

export {
  answerAsMessage,
  batchReplyPlan,
  normalizePermission,
  normalizeQuestion,
  planCancelsTurn,
  replyPlan,
  replyTransport,
} from "./interruptions/normalization";
export {
  type BarPresentation,
  type FeedLine,
  type Interruption,
  type InterruptionKind,
  type InterruptionOption,
  isPermissionResponse,
  type MessageLike,
  PERMISSION_VALUES,
  type PermissionLike,
  type PermissionResponse,
  QUESTION_TOOL,
  type QuestionPartLike,
  type ReplyContext,
  type ReplyPlan,
  type ToolPresentation,
} from "./interruptions/types";
