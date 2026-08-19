export function acceptEvent(state, event) {
  if (event.seq < state.seq) return state;
  return { seq: event.seq, text: state.text + event.delta };
}
