/** Streaming boundary for assistant output extraction. */
export function createStreamingAdapter({ emit }) {
  return function stream(event) {
    return emit(event);
  };
}
