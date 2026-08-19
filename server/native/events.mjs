import { randomUUID } from 'node:crypto';
import { CLUSTER_ENABLED, publishEvent, startCluster } from './cluster.mjs';
import { EVENT_RING_SIZE } from './config.mjs';
import { clearTurnResults, observeTurnResultEvent } from './turn-results.mjs';

const rings = new Map();
const subscribers = new Map();
// Sequence numbers restart with the process. Prefixing them with a process
// epoch prevents a reconnecting browser from mistaking fresh frames for old
// duplicates after a server restart.
const EVENT_EPOCH = randomUUID();
let clusterStarted = false;

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

// Remote frames get local ids so Last-Event-ID resume keeps working per
// instance, and they deliberately skip observeTurnResultEvent: the workspace
// snapshot belongs to the replica that is actually running the turn.
function deliver(sessionId, event) {
  const state = stateFor(sessionId);
  state.seq += 1;
  const frame = { id: `${EVENT_EPOCH}:${state.seq}`, seq: state.seq, event };
  state.frames.push(frame);
  if (state.frames.length > EVENT_RING_SIZE) state.frames.splice(0, state.frames.length - EVENT_RING_SIZE);
  for (const listener of listenersFor(sessionId)) {
    try { listener(frame); } catch { /* subscriber owns its socket */ }
  }
  return frame.id;
}

function ensureCluster() {
  if (clusterStarted || !CLUSTER_ENABLED) return;
  clusterStarted = true;
  startCluster({ ingest: deliver });
}

export function emit(sessionId, type, properties = {}) {
  ensureCluster();
  // Snapshot observation is synchronous on purpose: the initial `busy` event
  // happens before the first tool can mutate the workspace, so the baseline is
  // guaranteed to describe the exact state before this turn.
  try { observeTurnResultEvent(sessionId, type, properties); } catch { /* result capture must never break realtime delivery */ }

  const event = { type, properties: { ...properties, sessionID: properties.sessionID || sessionId } };
  const id = deliver(sessionId, event);
  // No-op on a single node. On a cluster the other replicas replay this frame
  // to their own subscribers, so an SSE stream is no longer pinned to the
  // process that happened to serve the request.
  try { publishEvent(sessionId, event); } catch { /* local delivery already happened */ }
  return id;
}

export function subscribe(sessionId, onFrame, lastEventId = 0) {
  ensureCluster();
  const state = stateFor(sessionId);
  const raw = String(lastEventId ?? '');
  const epochSeparator = raw.lastIndexOf(':');
  const suppliedEpoch = epochSeparator > 0 ? raw.slice(0, epochSeparator) : EVENT_EPOCH;
  const suppliedSeq = Number(epochSeparator > 0 ? raw.slice(epochSeparator + 1) : raw);
  // A different epoch means the caller survived a process restart. Replay the
  // complete retained ring; using its old sequence would silently drop every
  // new frame whose number has not caught up yet.
  const last = suppliedEpoch === EVENT_EPOCH && Number.isFinite(suppliedSeq)
    ? suppliedSeq
    : 0;
  for (const frame of state.frames) {
    if (frame.seq > last) onFrame(frame);
  }
  const set = listenersFor(sessionId);
  set.add(onFrame);
  return () => {
    set.delete(onFrame);
    if (set.size === 0) subscribers.delete(sessionId);
  };
}

// A reader that stops draining must not turn into unbounded process memory.
// Dropped clients reconnect with Last-Event-ID and the ring buffer replays what
// they missed, so disconnecting is cheaper and safer than buffering forever.
const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_SSE_STALL_MS = 180_000;

export function openSse(req, res, sessionId, lastEventId = 0) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    // Stop a reverse proxy from gzipping this response even if its default
    // encode matcher includes text/*.
    'content-encoding': 'identity',
  });
  // retry tells EventSource how soon to come back after a drop. A named ping
  // (not an SSE comment) actually reaches the client and keeps radio/NAT
  // mappings alive on mobile networks that ignore `: comment` frames.
  res.write('retry: 3000\n\n');
  res.write(': z-agent native stream\n\n');

  let unsubscribe = () => {};
  let heartbeat = null;
  let stalledSince = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };

  const drop = () => {
    close();
    try { res.destroy(); } catch { /* already gone */ }
  };

  const write = (frame) => {
    if (closed || res.writableEnded) return;
    if (res.write(frameText(frame))) {
      stalledSince = 0;
      return;
    }
    const now = Date.now();
    if (!stalledSince) stalledSince = now;
    if (res.writableLength > MAX_SSE_BUFFER_BYTES || now - stalledSince > MAX_SSE_STALL_MS) drop();
  };

  unsubscribe = subscribe(sessionId, write, lastEventId);
  if (closed) unsubscribe();

  heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    // Comment + named event: comments reset some proxies, named events reset
    // EventSource and the phone radio. 10s is under typical carrier NAT/idle
    // cuts (15–30s) without turning into chatter.
    const okComment = res.write(`: ping ${Date.now()}\n\n`);
    const okEvent = res.write('event: ping\ndata: {}\n\n');
    if ((!okComment || !okEvent) && res.writableLength > MAX_SSE_BUFFER_BYTES) drop();
  }, 10_000);
  heartbeat.unref?.();

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
