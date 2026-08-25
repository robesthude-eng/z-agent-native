export function createStreamSink(emit) {
  return (event) => emit?.(event);
}
