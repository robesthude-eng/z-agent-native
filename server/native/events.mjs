import { EVENT_RING_SIZE } from './config.mjs';
import { clearTurnResults, observeTurnResultEvent } from './turn-results.mjs';

const rings = new Map();
const subscribers = new Map();

function stateFor(sessionId) {
  let state = rings.get(sessionId);
  if (!state) {
    state = { seq: 0, frames: [] };
    rings.set(sessionId, state);
  }
  return state;
}

function listenersFor(sessionId) {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  return set;
}

function frameText(frame) {
  return `id: ${frame.id}\nevent: ${frame.event.type}\ndata: ${JSON.stringify(frame.event)}\n\n`;
}

export function emit(sessionId, type, properties = {}) {
  // Snapshot observation is synchronous on purpose: the initial `busy` event
  // happens before the first tool can mutate the workspace, so the baseline is
  // guaranteed to describe the exact state before this turn.
  try { observeTurnResultEvent(sessionId, type, properties); } catch { /* result capture must never break realtime delivery */ }

  const state = stateFor(sessionId);
  const event = { type, properties: { ...properties, sessionID: properties.sessionID || sessionId } };
  const frame = { id: ++state.seq, event };
  state.frames.push(frame);
  if (state.frames.length > EVENT_RING_SIZE) state.frames.splice(0, state.frames.length - EVENT_RING_SIZE);
  for (const listener of listenersFor(sessionId)) {
    try { listener(frame); } catch { /* subscriber owns its socket */ }
  }
  return frame.id;
}

export function subscribe(sessionId, onFrame, lastEventId = 0) {
  const state = stateFor(sessionId);
  const last = Number.isFinite(Number(lastEventId)) ? Number(lastEventId) : 0;
  for (const frame of state.frames) {
    if (frame.id > last) onFrame(frame);
  }
  const set = listenersFor(sessionId);
  set.add(onFrame);
  return () => {
    set.delete(onFrame);
    if (set.size === 0) subscribers.delete(sessionId);
  };
}

export function openSse(req, res, sessionId, lastEventId = 0) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': z-agent native stream\n\n');
  const write = (frame) => {
    if (!res.writableEnded) res.write(frameText(frame));
  };
  const unsubscribe = subscribe(sessionId, write, lastEventId);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref?.();
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  res.on('close', close);
}

export function clearSessionEvents(sessionId) {
  rings.delete(sessionId);
  clearTurnResults(sessionId);
}

export function resetEventsForTests() {
  rings.clear();
  subscribers.clear();
}
