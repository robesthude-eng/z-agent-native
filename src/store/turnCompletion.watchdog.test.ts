import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { isSseHealthyForSession } from "../api/events";
import { isVerdictSourceEnabled } from "../api/turnVerdict";
import type { Message } from "../api/types";
import { sessionFsm } from "./sessionFsm";
import { awaitTurnCompletion } from "./turnCompletion";

vi.mock("../api/events", () => ({
  isSseHealthyForSession: vi.fn(() => true),
}));

vi.mock("../api/turnVerdict", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/turnVerdict")>();
  return { ...actual, isVerdictSourceEnabled: vi.fn(() => false) };
});

const sid = "ses_watchdog";

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(isVerdictSourceEnabled).mockReturnValue(false);
  vi.mocked(isSseHealthyForSession).mockReturnValue(true);
  sessionFsm.markIdle(sid);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("watchdog preserves an unresolved turn instead of reporting success", async () => {
  const running: Message = {
    id: "msg_running",
    role: "assistant",
    parts: [{ type: "text", text: "работаю" }],
    info: {},
  };
  vi.spyOn(api, "listMessages").mockResolvedValue([running]);

  const onTurnProjection = vi.fn();
  const onWatchdogTimeout = vi.fn();
  const outcome = awaitTurnCompletion({
    sessionId: sid,
    requestGen: sessionFsm.beginRequest(sid),
    promptPromise: new Promise(() => {}),
    hardTimeoutMs: 10_000,
    onTurnProjection,
    onFailed: vi.fn(),
    onWatchdogTimeout,
    onSnapshot: vi.fn(),
  });

  await vi.advanceTimersByTimeAsync(9_999);
  expect(onWatchdogTimeout).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await outcome;

  expect(onTurnProjection).toHaveBeenLastCalledWith(null);
  expect(onWatchdogTimeout).toHaveBeenCalledTimes(1);
});

it("server-confirmed running turn keeps re-arming the watchdog", async () => {
  vi.mocked(isVerdictSourceEnabled).mockReturnValue(true);
  let lifecycle = "running";
  vi.spyOn(api, "turnState").mockImplementation(async () => ({
    orchestrator: true,
    turn: {
      turnId: "turn_new",
      lifecycle,
      verdict: lifecycle === "completed" ? "completed" : null,
      since: 1,
      reason: null,
    },
  }));
  vi.spyOn(api, "listMessages").mockResolvedValue([]);

  const onWatchdogTimeout = vi.fn();
  let finished = false;
  const outcome = awaitTurnCompletion({
    sessionId: sid,
    requestGen: sessionFsm.beginRequest(sid),
    promptPromise: new Promise(() => {}),
    hardTimeoutMs: 10_000,
    onTurnProjection: vi.fn(),
    onFailed: vi.fn(),
    onWatchdogTimeout,
    onSnapshot: vi.fn(),
  }).then(() => {
    finished = true;
  });

  // Длинный ход: в 5 раз дольше страховочного таймаута, сервер говорит running.
  await vi.advanceTimersByTimeAsync(50_000);
  expect(onWatchdogTimeout).not.toHaveBeenCalled();
  expect(finished).toBe(false);

  lifecycle = "completed";
  await vi.advanceTimersByTimeAsync(3_000);
  await outcome;
  expect(onWatchdogTimeout).not.toHaveBeenCalled();
  expect(finished).toBe(true);
});

it("a completed verdict of the previous turn does not close the new one", async () => {
  vi.mocked(isVerdictSourceEnabled).mockReturnValue(true);
  let turn = {
    turnId: "turn_old",
    lifecycle: "completed",
    verdict: "completed",
    since: 1,
    reason: null,
  };
  vi.spyOn(api, "turnState").mockImplementation(async () => ({
    orchestrator: true,
    turn,
  }));
  vi.spyOn(api, "listMessages").mockResolvedValue([]);

  let finished = false;
  const outcome = awaitTurnCompletion({
    sessionId: sid,
    requestGen: sessionFsm.beginRequest(sid),
    promptPromise: new Promise(() => {}),
    hardTimeoutMs: 60_000,
    staleTurnId: "turn_old",
    onTurnProjection: vi.fn(),
    onFailed: vi.fn(),
    onWatchdogTimeout: vi.fn(),
    onSnapshot: vi.fn(),
  }).then(() => {
    finished = true;
  });

  await vi.advanceTimersByTimeAsync(9_000);
  expect(finished).toBe(false);

  turn = {
    turnId: "turn_new",
    lifecycle: "completed",
    verdict: "completed",
    since: 2,
    reason: null,
  };
  await vi.advanceTimersByTimeAsync(3_000);
  await outcome;
  expect(finished).toBe(true);
});
