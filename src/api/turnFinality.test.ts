import { describe, expect, it } from "vitest";
import {
  assistantFinishState,
  FINAL_SETTLE_MS,
  finalMarkerOf,
  hasRunningTool,
  isStepFinish,
} from "./turnFinality";
import type { Message } from "./types";

const asst = (info: unknown, parts: unknown[] = []): Message =>
  ({ id: "m1", role: "assistant", parts, info }) as unknown as Message;

describe("isStepFinish", () => {
  it("узнаёт остановку ради инструмента в обоих написаниях", () => {
    expect(isStepFinish("tool-calls")).toBe(true);
    expect(isStepFinish("tool_calls")).toBe(true);
    // Регистр приходит от провайдера и не обязан быть нижним.
    expect(isStepFinish("TOOL-CALLS")).toBe(true);
  });

  it("настоящие причины конца хода шагом не считает", () => {
    expect(isStepFinish("stop")).toBe(false);
    expect(isStepFinish("error")).toBe(false);
    expect(isStepFinish(undefined)).toBe(false);
  });
});

describe("hasRunningTool", () => {
  it("живой инструмент виден и в объекте-состоянии, и в строке", () => {
    expect(
      hasRunningTool(
        asst({}, [{ type: "tool", state: { status: "running" } }]),
      ),
    ).toBe(true);
    expect(hasRunningTool(asst({}, [{ type: "tool", state: "pending" }]))).toBe(
      true,
    );
  });

  it("часть без состояния работой не считается", () => {
    // Иначе сообщение из старого HTTP-снимка не отпускало бы интерфейс никогда:
    // одна поломка сменилась бы другой.
    expect(hasRunningTool(asst({}, [{ type: "tool" }]))).toBe(false);
    expect(
      hasRunningTool(
        asst({}, [{ type: "tool", state: { status: "completed" } }]),
      ),
    ).toBe(false);
  });
});

describe("finalMarkerOf", () => {
  it("без finish и completed маркера нет", () => {
    expect(finalMarkerOf(asst({}))).toBe("none");
  });

  it("остановка ради инструмента — шаг", () => {
    expect(
      finalMarkerOf(asst({ finish: "tool-calls", time: { completed: 42 } })),
    ).toBe("step");
  });

  it("работающий инструмент перевешивает даже finish=stop", () => {
    // Ровно этот случай ломал интерфейс: движок закрывает сообщение шага
    // раньше, чем инструмент отдаёт результат, и сорокасекундный bash
    // выглядел законченным ходом всё время, пока команда выполняется.
    expect(
      finalMarkerOf(
        asst({ finish: "stop", time: { completed: 42 } }, [
          { type: "tool", tool: "bash", state: { status: "running" } },
        ]),
      ),
    ).toBe("step");
  });

  it("обычный конец хода — финал", () => {
    expect(finalMarkerOf(asst({ finish: "stop" }))).toBe("final");
    expect(finalMarkerOf(asst({ time: { completed: 42 } }))).toBe("final");
  });
});

describe("assistantFinishState", () => {
  it("смотрит на последнего ассистента", () => {
    const done = { ...asst({ finish: "stop" }), id: "m1" } as Message;
    const streaming = { ...asst({}), id: "m2" } as Message;
    expect(assistantFinishState([done, streaming]).isDone).toBe(false);
  });

  it("сигнатура двигается вместе со статусом инструмента", () => {
    // Без этого поллер видел бы два одинаковых замера подряд, пока команда
    // выполняется, и засчитал бы тишину за подтверждённый финал.
    const running = assistantFinishState([
      asst({ finish: "tool-calls" }, [
        { type: "tool", state: { status: "running" } },
      ]),
    ]).sig;
    const completed = assistantFinishState([
      asst({ finish: "tool-calls" }, [
        { type: "tool", state: { status: "completed" } },
      ]),
    ]).sig;
    expect(running).not.toBe(completed);
  });
});

describe("FINAL_SETTLE_MS", () => {
  it("совпадает с окном стабилизации арбитра на сервере", () => {
    // server/turn-reconciler.mjs → THRESHOLDS.STABILIZATION_MS. Разные окна
    // на клиенте и сервере — два разных ответа на вопрос «ход закончился?».
    expect(FINAL_SETTLE_MS).toBe(3_000);
  });
});
