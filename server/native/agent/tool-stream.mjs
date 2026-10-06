import { partId } from '../ids.mjs';
import { toolArgsPreview } from '../partial-json.mjs';

/**
 * Live cards for tool calls the model is still writing.
 *
 * Providers stream a tool call's arguments token by token, but the turn used to
 * wait for the whole response before it created any card. A large `write` then
 * looked frozen for as long as the model needed to produce the file, and all
 * the cards of a multi-tool step popped up one by one only as each ran. The
 * sink draws the card as soon as the tool name arrives, keeps its header
 * (path, command …) and a tail of the body current while the arguments stream,
 * and, once the response is complete, announces every call of the step so the
 * whole plan is visible before the first tool starts.
 *
 * Nothing here is persisted while streaming (the final state is written by the
 * normal tool cycle), and the real call is always taken from the final parsed
 * arguments, never from a preview.
 */

const TITLE_KEYS = ['path', 'filePath', 'file_path', 'command', 'pattern', 'query', 'url', 'description'];
const DEFAULT_THROTTLE_MS = 80;

export function previewTitle(name, input) {
  for (const key of TITLE_KEYS) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0].slice(0, 200);
  }
  return name;
}

export function createToolCallSink(assistant, { emit, persist, throttleMs = DEFAULT_THROTTLE_MS, now = Date.now } = {}) {
  /** @type {Map<string|number, {part: object, raw: unknown, dirty: boolean, last: number, timer: any}>} */
  const live = new Map();

  const send = (entry) => {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (!entry.dirty) return;
    entry.dirty = false;
    entry.last = now();
    const preview = toolArgsPreview(entry.raw);
    const part = entry.part;
    part.state = {
      ...part.state,
      input: preview.input,
      title: previewTitle(part.tool, preview.input),
      metadata: { ...(part.state.metadata || {}), streamingArgs: true, output: preview.output },
    };
    emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
  };

  const schedule = (entry) => {
    entry.dirty = true;
    if (entry.timer) return;
    const wait = Math.max(0, throttleMs - (now() - entry.last));
    if (wait === 0) { send(entry); return; }
    entry.timer = setTimeout(() => send(entry), wait);
    entry.timer.unref?.();
  };

  const removeParts = (parts) => {
    let removed = false;
    for (const part of parts) {
      const i = assistant.parts.indexOf(part);
      if (i === -1) continue;
      assistant.parts.splice(i, 1);
      removed = true;
      emit(assistant.sessionID, 'message.part.removed', { messageID: assistant.id, partID: part.id });
    }
    if (removed) persist?.(assistant);
  };

  const clear = () => {
    const parts = [];
    for (const entry of live.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      parts.push(entry.part);
    }
    live.clear();
    return parts;
  };

  return {
    /** Provider callback: the call `key` now has these (possibly partial) arguments. */
    onToolCall({ key, id, name, args }) {
      if (!name) return;
      let entry = live.get(key);
      if (!entry) {
        const part = {
          id: partId(),
          type: 'tool',
          tool: name,
          callID: id || `stream_${String(key)}`,
          state: { status: 'running', input: {}, title: name, metadata: { streamingArgs: true }, time: { start: now() } },
        };
        assistant.parts.push(part);
        entry = { part, raw: args, dirty: true, last: 0, timer: null };
        live.set(key, entry);
        send(entry);
        return;
      }
      entry.raw = args;
      if (id) entry.part.callID = id;
      schedule(entry);
    },

    /** The attempt failed or is being retried: drop every card it drew. */
    discard() {
      removeParts(clear());
    },

    /**
     * The response is complete. Pair the final calls with the cards drawn while
     * streaming (by position and tool name), drop cards the final response did
     * not keep, and create queued cards for calls that never streamed.
     * Returns one part per call, all marked `pending`.
     */
    bind(calls) {
      const drawn = [...live.values()].map((entry) => entry.part);
      for (const entry of live.values()) if (entry.timer) clearTimeout(entry.timer);
      live.clear();
      const used = new Set();
      const parts = calls.map((call, i) => {
        let part = drawn[i];
        if (part && part.tool === call.name) used.add(part);
        else part = null;
        const input = call.arguments || {};
        const state = {
          status: 'pending',
          input,
          title: previewTitle(call.name, input),
          time: { start: now() },
        };
        if (!part) {
          part = { id: partId(), type: 'tool', tool: call.name, callID: call.id, state };
          assistant.parts.push(part);
        } else {
          part.callID = call.id;
          part.state = state;
        }
        return part;
      });
      removeParts(drawn.filter((part) => !used.has(part)));
      for (const part of parts) emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
      return parts;
    },
  };
}
