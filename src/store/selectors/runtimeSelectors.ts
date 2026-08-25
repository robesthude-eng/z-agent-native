import type { State } from '../types';

export const selectActiveSession = (state: State) => state.currentID;
export const selectMessages = (state: State) => state.messages;
