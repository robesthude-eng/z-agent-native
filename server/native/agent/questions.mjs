import { emit } from '../events.mjs';
import { questionId } from '../ids.mjs';
import { createQuestion, findQuestionForRecovery, getQuestion, putMessage, resolveQuestion } from '../store.mjs';
import { emitPart } from './message-parts.mjs';
import { questionWaiters } from './state.mjs';

export function waitWithAbort(map, id, sessionId, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      map.delete(id);
      cleanup();
      reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
    };
    map.set(id, {
      sessionId,
      resolve: (value) => { map.delete(id); cleanup(); resolve(value); },
      reject: (err) => { map.delete(id); cleanup(); reject(err); },
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForQuestionAnswer(question, sessionId, signal) {
  const latest = getQuestion(question.id);
  if (latest?.status === 'answered' || latest?.status === 'rejected') return latest.answers || [];
  const waiting = waitWithAbort(questionWaiters, question.id, sessionId, signal);
  const afterRegistration = getQuestion(question.id);
  if (afterRegistration?.status === 'answered' || afterRegistration?.status === 'rejected') {
    questionWaiters.get(question.id)?.resolve(afterRegistration.answers || []);
  }
  return await waiting;
}

export async function askQuestion(sessionId, questions, signal, onCreated = null, updateTurn = null) {
  const id = questionId();
  createQuestion(id, sessionId, questions);
  onCreated?.(id);
  updateTurn?.(sessionId, { lifecycle: 'waiting_user_input', since: Date.now(), reason: 'question' });
  emit(sessionId, 'question.asked', { id, questions });
  const answers = await waitForQuestionAnswer({ id }, sessionId, signal);
  updateTurn?.(sessionId, { lifecycle: 'running', since: Date.now(), reason: 'question_answered' });
  return { id, answers };
}

export async function resumePendingQuestion(sessionId, assistant, signal, updateTurn = null) {
  const part = (assistant.parts || []).find((candidate) => {
    const status = String(candidate?.state?.status || '');
    return candidate?.type === 'tool' && candidate?.tool === 'question' && ['running', 'pending'].includes(status);
  });
  if (!part) return false;
  const inputQuestions = Array.isArray(part.state?.input?.questions) ? part.state.input.questions : [];
  const stored = part.state?.metadata?.questionId
    ? getQuestion(part.state.metadata.questionId)
    : findQuestionForRecovery(sessionId, inputQuestions);
  if (!stored || stored.sessionID !== sessionId) return false;

  updateTurn?.(sessionId, { lifecycle: stored.status === 'pending' ? 'waiting_user_input' : 'running', since: Date.now(), reason: 'question_recovered' });
  if (stored.status === 'pending') emit(sessionId, 'question.asked', { id: stored.id, questions: stored.questions, recovered: true });
  const answers = await waitForQuestionAnswer(stored, sessionId, signal);
  part.state = {
    ...part.state,
    status: 'completed',
    output: `User answered: ${JSON.stringify(answers)}`,
    metadata: { ...(part.state?.metadata || {}), answers, questionId: stored.id, recovered: true },
    time: { ...(part.state?.time || {}), end: Date.now() },
  };
  emitPart(assistant, part, { putMessage, emit });
  updateTurn?.(sessionId, { lifecycle: 'running', since: Date.now(), reason: 'question_answered_after_restart' });
  return true;
}

export function answerQuestion(sessionId, id, answers) {
  const q = getQuestion(id);
  if (!q || q.sessionID !== sessionId || q.status !== 'pending') return false;
  resolveQuestion(id, answers, 'answered');
  emit(sessionId, 'question.replied', { id, answers });
  const waiter = questionWaiters.get(id);
  waiter?.resolve(answers);
  return true;
}

export function rejectQuestion(sessionId, id) {
  const q = getQuestion(id);
  if (!q || q.sessionID !== sessionId || q.status !== 'pending') return false;
  resolveQuestion(id, [], 'rejected');
  emit(sessionId, 'question.rejected', { id });
  const waiter = questionWaiters.get(id);
  waiter?.resolve([]);
  return true;
}
