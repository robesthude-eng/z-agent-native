/**
 * Interruption and Question Protocol Facade for Z-Agent Native.
 * Modular implementations live in src/api/interruptions/*.
 */

export {
  PERMISSION_VALUES,
  type PermissionResponse,
  isPermissionResponse,
  type InterruptionKind,
  type InterruptionOption,
  type Interruption,
  type PermissionLike,
  type ToolPresentation,
  type ReplyPlan,
  type ReplyContext,
  type BarPresentation,
  QUESTION_TOOL,
  type QuestionPartLike,
  type MessageLike,
  type FeedLine,
} from "./interruptions/types";

export {
  normalizePermission,
  normalizeQuestion,
  replyTransport,
  replyPlan,
  batchReplyPlan,
  answerAsMessage,
  planCancelsTurn,
} from "./interruptions/normalization";

export {
  BAR_COLLAPSE_LINES,
  isInterruptionBarEnabled,
  barPresentation,
  isLongForBar,
  isBarQuestionPart,
  isInterruptedQuestionPart,
  answerFromFeed,
  replyTextAfterCall,
  optionsLayout,
  activeQuestion,
  feedTrace,
  questionFeedLine,
  hasQuestionPart,
  replyWarning,
  barWarning,
} from "./interruptions/feed";
