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
