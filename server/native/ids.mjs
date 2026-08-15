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
