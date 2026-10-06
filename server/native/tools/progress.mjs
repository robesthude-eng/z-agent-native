/**
 * Status lines for tools that have no stdout of their own.
 *
 * `bash`, `git` and friends stream the process output into the card. Tools such
 * as `browser`, `webfetch`, `cloud_sandbox` or a `task` subagent do their work
 * inside the runtime and used to show an empty "running" card until the very
 * end. A progress log gives them a small timeline ("[2 с] Открываю …") that goes
 * through the same live-output channel (`ctx.onOutput`) as command output, so
 * it needs no new transport, and the card is replaced by the real result when
 * the tool finishes.
 *
 * Display only: it never throws and never changes what the tool returns.
 */

const DEFAULT_INTERVAL_MS = 100;
const MAX_CHARS = 4000;
const MAX_LINE_CHARS = 220;

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} м ${String(seconds).padStart(2, '0')} с`;
}

export function clipLine(text, max = MAX_LINE_CHARS) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const NOOP = Object.freeze({
  step() {},
  replaceLast() {},
  ticker() { return () => {}; },
  stop() {},
  text: () => '',
  active: false,
});

export function createProgressLog(onOutput, { intervalMs = DEFAULT_INTERVAL_MS, now = Date.now } = {}) {
  if (typeof onOutput !== 'function') return NOOP;
  const startedAt = now();
  const lines = [];
  const timers = new Set();
  let timer = null;
  let dirty = false;
  let lastSent = 0;
  let stopped = false;

  const render = () => {
    let text = lines.join('\n');
    if (text.length > MAX_CHARS) {
      // Keep the newest lines; the card is a live tail, the full result comes at the end.
      let cut = lines.length;
      let size = 0;
      while (cut > 0 && size + lines[cut - 1].length + 1 <= MAX_CHARS - 20) { cut -= 1; size += lines[cut].length + 1; }
      text = `[…ранние шаги скрыты]\n${lines.slice(cut).join('\n')}`;
    }
    return text;
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (stopped || !dirty) return;
    dirty = false;
    lastSent = now();
    try { onOutput(render()); } catch { /* display only */ }
  };

  const schedule = () => {
    dirty = true;
    if (timer || stopped) return;
    const wait = intervalMs - (now() - lastSent);
    if (wait <= 0) { flush(); return; }
    timer = setTimeout(flush, wait);
    timer.unref?.();
  };

  const stamp = () => `[${formatElapsed(now() - startedAt)}]`;

  return {
    active: true,
    /** Append a line. */
    step(text) {
      if (stopped) return;
      lines.push(`${stamp()} ${clipLine(text)}`);
      schedule();
    },
    /** Rewrite the last line (progress of the step that is still running). */
    replaceLast(text) {
      if (stopped) return;
      const line = `${stamp()} ${clipLine(text)}`;
      if (lines.length) lines[lines.length - 1] = line; else lines.push(line);
      schedule();
    },
    /**
     * A line that shows how long a long step has been running ("Выполняю … · 12 с").
     * Call the returned function when the step ends, optionally with the final text.
     */
    ticker(label, { everyMs = 1000 } = {}) {
      if (stopped) return () => {};
      const from = now();
      lines.push(`${stamp()} ${clipLine(label)}`);
      const index = lines.length - 1;
      const at = stamp();
      const tick = setInterval(() => {
        if (stopped) return;
        lines[index] = `${at} ${clipLine(`${label} · ${formatElapsed(now() - from)}`)}`;
        schedule();
      }, everyMs);
      tick.unref?.();
      timers.add(tick);
      schedule();
      return (finalText) => {
        clearInterval(tick);
        timers.delete(tick);
        if (stopped) return;
        lines[index] = `${at} ${clipLine(finalText ?? `${label} · ${formatElapsed(now() - from)}`)}`;
        schedule();
      };
    },
    /** Stop timers and drop anything not yet delivered. */
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const t of timers) clearInterval(t);
      timers.clear();
    },
    text: render,
  };
}
