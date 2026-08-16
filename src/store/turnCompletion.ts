import { isAbortError } from "../api/abortRegistry";
import { api, SessionGoneError } from "../api/client";
import { isSseHealthyForSession } from "../api/events";
import { assistantFinishState, finalMarkerOf } from "../api/turnFinality";
import {
  dispositionOf,
  isSettled,
  isVerdictSourceEnabled,
  parseTurnState,
  type TurnProjection,
  VERDICT_POLL_MS,
} from "../api/turnVerdict";
import type { Message } from "../api/types";
import { log } from "../lib/log";
import { sessionFsm } from "./sessionFsm";

export interface TurnCompletionOptions {
  sessionId: string;
  requestGen: number;
  promptPromise: Promise<Message | null>;
  onTurnProjection: (turn: TurnProjection | null) => void;
  onFailed: () => void;
  /**
   * Watchdog is not a successful finish. It only says the browser could not
   * obtain an authoritative verdict in time. If omitted, failure handling is
   * used for backward compatibility with existing callers/tests.
   */
  onWatchdogTimeout?: () => void;
  onSnapshot: (msgs: Message[]) => void;
  hardTimeoutMs: number;
}

export function awaitTurnCompletion(
  opts: TurnCompletionOptions,
): Promise<void> {
  const {
    sessionId: sidStr,
    requestGen,
    promptPromise,
    onTurnProjection,
    onFailed,
    onWatchdogTimeout = onFailed,
    onSnapshot,
    hardTimeoutMs,
  } = opts;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (_reason: string) => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const fromServer = isVerdictSourceEnabled();

    let verdictPoller: ReturnType<typeof setInterval> | null = null;
    if (fromServer) {
      verdictPoller = setInterval(async () => {
        if (settled) {
          if (verdictPoller) clearInterval(verdictPoller);
          return;
        }
        let state: unknown;
        try {
          state = await api.turnState(sidStr);
        } catch (e) {
          if (e instanceof SessionGoneError) {
            if (verdictPoller) clearInterval(verdictPoller);
            clearTimeout(timeoutId);
            if (!settled) {
              settled = true;
              reject(e);
            }
          }
          return;
        }
        const parsed = parseTurnState(state);
        if (!parsed) return;
        onTurnProjection(parsed.turn);
        if (!parsed.orchestrator) {
          log.warn(
            "[send] verdict source is on in the client, but the server has no orchestrator",
          );
          if (verdictPoller) clearInterval(verdictPoller);
          clearTimeout(timeoutId);
          done("server:no-orchestrator");
          return;
        }
        if (isSettled(parsed.turn)) {
          if (verdictPoller) clearInterval(verdictPoller);
          clearTimeout(timeoutId);
          if (dispositionOf(parsed.turn) === "failed") onFailed();
          done("server:verdict");
        }
      }, VERDICT_POLL_MS);
    }

    if (!fromServer) {
      sessionFsm.onIdle(
        sidStr,
        () => {
          done("sse:session.idle");
        },
        requestGen,
      );
    }

    let lastSignature = "";
    const httpPoller = setInterval(async () => {
      if (settled) {
        clearInterval(httpPoller);
        return;
      }
      try {
        const msgs = await api.listMessages(sidStr);
        const sseHealthy = isSseHealthyForSession(sidStr);
        if (!sseHealthy && Array.isArray(msgs) && msgs.length > 0) {
          onSnapshot(msgs as Message[]);
        }
        if (fromServer) return;

        const { isDone, sig } = assistantFinishState(msgs as Message[]);
        if (isDone && sig === lastSignature) {
          clearInterval(httpPoller);
          clearTimeout(timeoutId);
          sessionFsm.clearIdleResolver(sidStr, requestGen);
          done("http:stable-finish");
        } else {
          lastSignature = sig;
        }
      } catch (pollErr) {
        if (pollErr instanceof SessionGoneError) {
          clearInterval(httpPoller);
          clearTimeout(timeoutId);
          sessionFsm.clearIdleResolver(sidStr, requestGen);
          if (!settled) {
            settled = true;
            reject(pollErr);
          }
          return;
        }
      }
    }, 3000);

    const timeoutId = setTimeout(() => {
      if (settled) return;
      log.warn(
        fromServer
          ? `[send] server verdict did not arrive within ${hardTimeoutMs}ms — preserving unresolved state`
          : `[send] hard timeout after ${hardTimeoutMs}ms — preserving unresolved state`,
      );
      clearInterval(httpPoller);
      if (verdictPoller) clearInterval(verdictPoller);
      sessionFsm.clearIdleResolver(sidStr, requestGen);
      // Do not leave a stale "running" projection visible after the watchdog.
      // `null` means exactly what we know now: no authoritative projection.
      onTurnProjection(null);
      onWatchdogTimeout();
      done("hard-timeout");
    }, hardTimeoutMs);

    promptPromise
      .then((responseMsg) => {
        if (!responseMsg) return;
        if (fromServer) return;
        const finish = responseMsg?.info?.finish;
        if (finalMarkerOf(responseMsg as Message) === "final") {
          clearInterval(httpPoller);
          clearTimeout(timeoutId);
          sessionFsm.clearIdleResolver(sidStr, requestGen);
          done(
            finish === "error" ? "prompt:finish-error" : "prompt:finish-stop",
          );
        }
      })
      .catch((e) => {
        if (isAbortError(e)) return;
        clearInterval(httpPoller);
        if (verdictPoller) clearInterval(verdictPoller);
        clearTimeout(timeoutId);
        sessionFsm.clearIdleResolver(sidStr, requestGen);
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
  });
}
