/**
 * Persistent Data Store Facade for Z-Agent Native.
 * Modular implementations live in server/native/store/*.
 */


export {
  auditEventCount,
  claimAction,
  completeAction,
  dequeueAction,
  enqueueAction,
  failAction,
  getAction,
  insertAuditEventInCurrentTransaction,
  listQueue,
  recordAuditEvent,
  resetAction,
  sanitizeAuditDetails,
  verifyAuditLog,
} from './store/actions.mjs';

export {
  authRateLimitExceeded,
  authSessionKey,
  createAuthSession,
  createRegistrationUser,
  createUser,
  deleteAuthSession,
  deleteOtherAuthSessions,
  getAuthSession,
  getUser,
  pruneAuthSessions,
  recordAuthFailures,
  updatePassword,
  updatePasswordAndRevokeSessions,
  userCount,
} from './store/auth.mjs';

export {
  allocateSandboxUid,
  chatRow,
  createChat,
  deleteChat,
  getChat,
  getSandboxUid,
  listChats,
  ownsChat,
  renameChat,
  touchChat,
  workspaceFor,
} from './store/chats.mjs';
export {
  closeStore,
  db,
  storeReadinessCheck,
} from './store/db.mjs';
export {
  deleteMessagesFrom,
  getMessage,
  listMessages,
  messageRow,
  putMessage,
} from './store/messages.mjs';

export {
  deleteManualModel,
  deleteProviderKey,
  getPrefs,
  getProviderKey,
  listHiddenModels,
  listManualModels,
  listProviderKeyIds,
  listProviderKeys,
  setHiddenModel,
  setPrefs,
  setProviderKey,
  upsertManualModel,
} from './store/prefs.mjs';
export {
  clearTurn,
  createPermission,
  createQuestion,
  findQuestionForRecovery,
  getPermission,
  getQuestion,
  getTurn,
  listPendingQuestions,
  recoverInterruptedRuntimeState,
  releaseTurnCapacity,
  renewTurnCapacity,
  reserveTurnCapacity,
  resolvePermission,
  resolveQuestion,
  setTurn,
  turnCapacityCounts,
} from './store/turns.mjs';
