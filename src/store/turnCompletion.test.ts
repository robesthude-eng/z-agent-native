/**
 * Сведение источников завершения хода.
 *
 * До выноса это были 250 строк внутри пятисотстрочного `send()`, и проверить
 * их было нечем. Проверяется здесь не «поллер опрашивает», а то единственное,
 * ради чего вся конструкция существует: интерфейс отпускается ровно один раз и
 * ровно по правильному поводу. Обе ошибки дорогие и обе уже случались —
 * зависший спиннер и ход, закрытый посреди работы агента.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, SessionGoneError } from "../api/client";
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

const sid = "ses_turn";
const HARD_TIMEOUT = 60_000;

/** Ход, который движок считает законченным. */
const finishedMessage = (text: string): Message =>
  ({
    id: "msg_a1",
    role: "assistant",
    parts: [{ type: "text", text }],
    info: { finish: "stop", time: { completed: 1 } },
  }) as unknown as Message;

/** Тот же ход, но частей стало больше — структурное изменение. */
const grownMessage = (): Message =>
  ({
    id: "msg_a1",
    role: "assistant",
    parts: [
      { type: "text", text: "часть" },
      { type: "text", text: "вторая" },
    ],
    info: { finish: "stop", time: { completed: 1 } },
  }) as unknown as Message;

/** Ход в работе: инструмент ещё крутится. */
const runningMessage = (text: string): Message =>
  ({
    id: "msg_a1",
    role: "assistant",
    parts: [{ type: "text", text }],
    info: {},
  }) as unknown as Message;

function run(over: Partial<Parameters<typeof awaitTurnCompletion>[0]> = {}) {
  const onTurnProjection = vi.fn();
  const onFailed = vi.fn();
  const onSnapshot = vi.fn();
  const promise = awaitTurnCompletion({
    sessionId: sid,
    requestGen: 1,
    promptPromise: new Promise(() => {}),
    hardTimeoutMs: HARD_TIMEOUT,
    onTurnProjection,
    onFailed,
    onSnapshot,
    ...over,
  });
  // Реджект перехватывается сразу: неперехваченный reject в fake-timers
  // всплывает как unhandled rejection и роняет посторонний тест.
  const outcome = promise.then(
    () => "resolved" as const,
    (e) => ({ rejected: e }),
  );
  return { outcome, onTurnProjection, onFailed, onSnapshot };
}

/** Прокрутить таймеры и дать микрозадачам (await внутри интервалов) отработать. */
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

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

describe("прежний путь: SSE session.idle", () => {
  it("резолвер отпускает интерфейс, не дожидаясь поллера", async () => {
    // Сообщения при этом выглядят НЕзаконченными: закрывает ход именно SSE,
    // а не HTTP-страховка.
    vi.spyOn(api, "listMessages").mockResolvedValue([runningMessage("...")]);
    const gen = sessionFsm.beginRequest(sid);
    const { outcome } = run({ requestGen: gen });

    await tick(0);
    expect(sessionFsm.resolveIdle(sid)).toBe(true);
    await tick(0);
    await expect(outcome).resolves.toBe("resolved");
  });
});

describe("HTTP-поллер: финал только после двух одинаковых замеров", () => {
  it("один замер финалом не считается", async () => {
    vi.spyOn(api, "listMessages").mockResolvedValue([finishedMessage("ответ")]);
    const { outcome } = run();

    // Первый замер: состояние выглядит законченным, но подтверждения нет.
    await tick(3000);
    let state: unknown = "pending";
    outcome.then((v) => {
      state = v;
    });
    await tick(0);
    expect(state).toBe("pending");

    // Второй такой же замер — вот теперь финал.
    await tick(3000);
    await expect(outcome).resolves.toBe("resolved");
  });

  it("выросшее число частей сбрасывает подтверждение", async () => {
    // Сигнатура намеренно структурная (id, число частей, finish, статусы
    // инструментов), а не текстовая: дописанный токен внутри той же части —
    // не признак продолжающейся работы, а новая часть — признак.
    const list = vi.spyOn(api, "listMessages");
    list.mockResolvedValue([finishedMessage("часть")]);
    const { outcome } = run();

    await tick(3000);
    list.mockResolvedValue([grownMessage()]);
    await tick(3000);

    let state: unknown = "pending";
    outcome.then((v) => {
      state = v;
    });
    await tick(0);
    expect(state).toBe("pending");

    // Стабилизировалось — закрываем.
    await tick(3000);
    await expect(outcome).resolves.toBe("resolved");
  });

  it("незаконченный ход не закрывается никогда (до таймаута)", async () => {
    vi.spyOn(api, "listMessages").mockResolvedValue([
      runningMessage("думаю..."),
    ]);
    const { outcome } = run();

    await tick(3000 * 10);
    let state: unknown = "pending";
    outcome.then((v) => {
      state = v;
    });
    await tick(0);
    expect(state).toBe("pending");
  });
});

describe("снимок сервера пишется только при сломанном SSE", () => {
  it("здоровый SSE — снимок не пишем", async () => {
    vi.mocked(isSseHealthyForSession).mockReturnValue(true);
    vi.spyOn(api, "listMessages").mockResolvedValue([runningMessage("x")]);
    const { onSnapshot } = run();

    await tick(3000);
    // Снимок отстаёт от SSE-дельт и откатывал бы стриминговый текст.
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("сломанный SSE — снимок пишем, иначе ответу неоткуда взяться", async () => {
    vi.mocked(isSseHealthyForSession).mockReturnValue(false);
    vi.spyOn(api, "listMessages").mockResolvedValue([runningMessage("x")]);
    const { onSnapshot } = run();

    await tick(3000);
    expect(onSnapshot).toHaveBeenCalled();
  });
});

describe("мёртвая сессия", () => {
  it("поллер реджектит промис", async () => {
    vi.spyOn(api, "listMessages").mockRejectedValue(new SessionGoneError(sid));
    const { outcome } = run();

    await tick(3000);
    const res = (await outcome) as { rejected: unknown };
    expect(res.rejected).toBeInstanceOf(SessionGoneError);
  });

  it("обычная сетевая ошибка поллера — не финал и не отказ", async () => {
    const list = vi.spyOn(api, "listMessages");
    list.mockRejectedValue(new Error("Failed to fetch"));
    const { outcome } = run();

    await tick(3000 * 3);
    let state: unknown = "pending";
    outcome.then((v) => {
      state = v;
    });
    await tick(0);
    expect(state).toBe("pending");

    // Сеть вернулась — ход закрывается обычным путём.
    list.mockResolvedValue([finishedMessage("ок")]);
    await tick(3000);
    await tick(3000);
    await expect(outcome).resolves.toBe("resolved");
  });
});

describe("страховочный таймаут", () => {
  it("отпускает интерфейс, когда молчат все источники", async () => {
    vi.spyOn(api, "listMessages").mockResolvedValue([runningMessage("...")]);
    const { outcome } = run();

    await tick(HARD_TIMEOUT - 1);
    let state: unknown = "pending";
    outcome.then((v) => {
      state = v;
    });
    await tick(0);
    expect(state).toBe("pending");

    await tick(1);
    await expect(outcome).resolves.toBe("resolved");
  });
});

describe("новый путь: вердикт сервера", () => {
  beforeEach(() => {
    vi.mocked(isVerdictSourceEnabled).mockReturnValue(true);
  });

  it("settled-вердикт закрывает ход", async () => {
    const list = vi.spyOn(api, "listMessages").mockResolvedValue([]);
    vi.spyOn(api, "turnState").mockResolvedValue({
      orchestrator: true,
      turn: { turnId: "turn_1", lifecycle: "completed", verdict: "completed" },
    } as never);
    const { outcome, onTurnProjection } = run();

    await tick(3000);
    await expect(outcome).resolves.toBe("resolved");
    // Проекция кладётся в стор до всякого решения о завершении.
    expect(onTurnProjection).toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("failed-вердикт помечает сессию ошибкой", async () => {
    vi.spyOn(api, "listMessages").mockResolvedValue([]);
    vi.spyOn(api, "turnState").mockResolvedValue({
      orchestrator: true,
      turn: { turnId: "turn_1", lifecycle: "failed", verdict: "failed" },
    } as never);
    const { outcome, onFailed } = run();

    await tick(3000);
    await expect(outcome).resolves.toBe("resolved");
    expect(onFailed).toHaveBeenCalled();
  });

  it("нет оркестратора на сервере — не висим молча", async () => {
    // Рассогласование конфигурации: флаг включён, вердикта не будет никогда.
    vi.spyOn(api, "listMessages").mockResolvedValue([]);
    vi.spyOn(api, "turnState").mockResolvedValue({
      orchestrator: false,
      turn: null,
    } as never);
    const { outcome } = run();

    await tick(3000);
    await expect(outcome).resolves.toBe("resolved");
  });

  it("на новом пути финал НЕ выводится из ответа движка", async () => {
    // Главное утверждение блока: клиент больше не арбитр. Поллер видит
    // законченный ход, но вердикта сервера нет — значит ход не закрывается.
    vi.spyOn(api, "listMessages").mockResolvedValue([finishedMessage("ответ")]);
    vi.spyOn(api, "turnState").mockResolvedValue({
      orchestrator: true,
      turn: { turnId: "turn_1", lifecycle: "running", verdict: null },
    } as never);
    const { outcome } = run();

    await tick(3000 * 5);
    let state: unknown = "pending";
    outcome.then((v) => {
      state = v;
    });
    await tick(0);
    expect(state).toBe("pending");
  });
});

describe("ответ на промпт", () => {
  it("финальный маркер закрывает ход на прежнем пути", async () => {
    vi.spyOn(api, "listMessages").mockResolvedValue([]);
    const { outcome } = run({
      promptPromise: Promise.resolve(finishedMessage("готово")),
    });

    await tick(0);
    await expect(outcome).resolves.toBe("resolved");
  });

  it("null (обрыв после доставки) ход не закрывает", async () => {
    vi.spyOn(api, "listMessages").mockResolvedValue([runningMessage("...")]);
    const { outcome } = run({ promptPromise: Promise.resolve(null) });

    await tick(3000);
    let state: unknown = "pending";
    outcome.then((v) => {
      state = v;
    });
    await tick(0);
    expect(state).toBe("pending");
  });

  it("ошибка отправки реджектит промис", async () => {
    vi.spyOn(api, "listMessages").mockResolvedValue([]);
    const { outcome } = run({
      promptPromise: Promise.reject(new Error("boom")),
    });

    await tick(0);
    const res = (await outcome) as { rejected: Error };
    expect(res.rejected.message).toBe("boom");
  });
});
