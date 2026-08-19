import crypto from 'node:crypto';

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export const sessionId = () => id('ses');
export const messageId = () => id('msg');
export const partId = () => id('part');
export const turnId = () => id('turn');
export const questionId = () => id('que');
export const permissionId = () => id('per');
export const callId = () => id('call');

export function assertActionId(value) {
  const actionId = String(value || '').trim();
  if (!/^act_[A-Za-z0-9_-]{8,124}$/.test(actionId)) {
    throw Object.assign(new Error('Invalid action id'), { statusCode: 400 });
  }
  return actionId;
}
