/**
 * Persistent Data Store Facade for Z-Agent Native.
 * Modular implementations live in server/native/store/*.
 */

export {
  db,
  closeStore,
  storeReadinessCheck,
} from './store/db.mjs';

export {
  authSessionKey,
  createUser,
  createRegistrationUser,
  getUser,
  userCount,
  updatePassword,
  updatePasswordAndRevokeSessions,
  createAuthSession,
  getAuthSession,
  deleteAuthSession,
  deleteOtherAuthSessions,
  pruneAuthSessions,
  authRateLimitExceeded,
  recordAuthFailures,
} from './store/auth.mjs';

export {
  allocateSandboxUid,
  workspaceFor,
  chatRow,
  createChat,
  listChats,
  getChat,
  ownsChat,
  getSandboxUid,
  renameChat,
  touchChat,
  deleteChat,
} from './store/chats.mjs';

export {
  messageRow,
  putMessage,
  getMessage,
  listMessages,
  deleteMessagesFrom,
} from './store/messages.mjs';

export {
  setTurn,
  getTurn,
  clearTurn,
  reserveTurnCapacity,
  renewTurnCapacity,
  releaseTurnCapacity,
  turnCapacityCounts,
  recoverInterruptedRuntimeState,
  createQuestion,
  listPendingQuestions,
  resolveQuestion,
  getQuestion,
  findQuestionForRecovery,
  createPermission,
  resolvePermission,
  getPermission,
} from './store/turns.mjs';

export {
  getPrefs,
  setPrefs,
  listProviderKeys,
  listProviderKeyIds,
  getProviderKey,
  setProviderKey,
  deleteProviderKey,
  listManualModels,
  upsertManualModel,
  deleteManualModel,
  listHiddenModels,
  setHiddenModel,
} from './store/prefs.mjs';

export {
  getAction,
  claimAction,
  completeAction,
  failAction,
  resetAction,
  listQueue,
  enqueueAction,
  dequeueAction,
  sanitizeAuditDetails,
  insertAuditEventInCurrentTransaction,
  recordAuditEvent,
  verifyAuditLog,
  auditEventCount,
} from './store/actions.mjs';
