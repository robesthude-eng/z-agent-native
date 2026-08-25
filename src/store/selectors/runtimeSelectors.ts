import type { State } from '../types';

export const selectActiveSession = (state: State) => state.activeSessionId;
export const selectMessages = (state: State) => state.messages;
