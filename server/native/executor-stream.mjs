import { StringDecoder } from 'node:string_decoder';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// Internal IPC: bounded NDJSON snapshots and one terminal result. Never buffer
// the entire lifetime of a long-running command, or decode split UTF-8 chunks.
export function createExecutorStreamParser(onOutput) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let terminal = null;
  const read = (text) => {
    pending += text;
    for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Executor stream frame exceeded 4 MiB');
      if (terminal) throw new Error('Executor stream continued after terminal result');
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new Error('Executor returned invalid stream JSON');
      }
      if (frame?.type === 'output') {
        if (typeof frame.stdout !== 'string' || typeof frame.stderr !== 'string') throw new Error('Invalid executor output frame');
        try {
          onOutput?.(frame.stdout, frame.stderr);
        } catch {
          /* UI consumer cannot fail execution. */
        }
      } else if (frame?.type === 'result') {
        if (!frame.result || !Number.isInteger(frame.result.code)) throw new Error('Invalid executor terminal result');
        terminal = frame;
      } else if (frame?.type === 'error') {
        terminal = frame;
      } else throw new Error('Unknown executor stream frame');
    }
    if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) throw new Error('Executor stream frame exceeded 4 MiB');
  };
  return {
    push(chunk) {
      read(decoder.write(chunk));
    },
    finish() {
      read(decoder.end());
      if (pending.trim()) throw new Error('Executor stream ended with an incomplete frame');
      if (!terminal) throw new Error('Executor stream ended without a terminal result');
      if (terminal.type === 'error')
        throw Object.assign(new Error(terminal.error || 'Executor execution failed'), { code: terminal.code || 'EXECUTOR_ERROR' });
      return terminal.result;
    },
  };
}
