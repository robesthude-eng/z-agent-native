import { beforeEach, describe, expect, it } from "vitest";
import { SessionFsm } from "./sessionFsm";

describe("SessionFsm", () => {
  let fsm: SessionFsm;

  beforeEach(() => {
    fsm = new SessionFsm();
  });

  it("tracks busy state per session", () => {
    expect(fsm.isBusy("a")).toBe(false);
    fsm.markBusy("a");
    expect(fsm.isBusy("a")).toBe(true);
    expect(fsm.isBusy("b")).toBe(false);
    fsm.markIdle("a");
    expect(fsm.isBusy("a")).toBe(false);
  });

  it("resolveIdle fires and clears the resolver once", () => {
    let calls = 0;
    fsm.onIdle("a", () => calls++);
    expect(fsm.resolveIdle("a")).toBe(true);
    expect(calls).toBe(1);
    // повторный вызов — no-op
    expect(fsm.resolveIdle("a")).toBe(false);
    expect(calls).toBe(1);
  });

  it("returns false when no resolver registered", () => {
    expect(fsm.resolveIdle("missing")).toBe(false);
  });

  it("chains resolvers on double send (previous fires first)", () => {
    const order: string[] = [];
    fsm.onIdle("a", () => order.push("first"));
    fsm.onIdle("a", () => order.push("second"));
    expect(fsm.resolveIdle("a")).toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("swallows errors from a chained previous resolver", () => {
    let called = false;
    fsm.onIdle("a", () => {
      throw new Error("boom");
    });
    fsm.onIdle("a", () => {
      called = true;
    });
    expect(() => fsm.resolveIdle("a")).not.toThrow();
    expect(called).toBe(true);
  });

  it("clearIdleResolver removes without firing", () => {
    let calls = 0;
    fsm.onIdle("a", () => calls++);
    fsm.clearIdleResolver("a");
    expect(fsm.resolveIdle("a")).toBe(false);
    expect(calls).toBe(0);
  });

  it("markIdle does not clear the resolver (legacy behavior)", () => {
    let calls = 0;
    fsm.markBusy("a");
    fsm.onIdle("a", () => calls++);
    fsm.markIdle("a");
    expect(fsm.resolveIdle("a")).toBe(true);
    expect(calls).toBe(1);
  });

  it("keeps sessions isolated", () => {
    const order: string[] = [];
    fsm.onIdle("a", () => order.push("a"));
    fsm.onIdle("b", () => order.push("b"));
    fsm.resolveIdle("b");
    expect(order).toEqual(["b"]);
  });

  it("reset clears all state", () => {
    fsm.markBusy("a");
    fsm.onIdle("a", () => {});
    fsm.reset();
    expect(fsm.isBusy("a")).toBe(false);
    expect(fsm.resolveIdle("a")).toBe(false);
  });

  it("Релиз 4: устаревшее поколение не снимает busy нового send()", () => {
    const gen1 = fsm.beginRequest("a");
    const gen2 = fsm.beginRequest("a");
    fsm.markIdle("a", gen1); // поздний hard-timeout первого send()
    expect(fsm.isBusy("a")).toBe(true);
    fsm.markIdle("a", gen2);
    expect(fsm.isBusy("a")).toBe(false);
  });

  it("Релиз 4: isCurrent отличает актуальное поколение", () => {
    const gen1 = fsm.beginRequest("a");
    expect(fsm.isCurrent("a", gen1)).toBe(true);
    const gen2 = fsm.beginRequest("a");
    expect(fsm.isCurrent("a", gen1)).toBe(false);
    expect(fsm.isCurrent("a", gen2)).toBe(true);
  });

  it("Релиз 4: clearIdleResolver с поколением снимает только свой резолвер", () => {
    const order: string[] = [];
    const gen1 = fsm.beginRequest("a");
    fsm.onIdle("a", () => order.push("first"), gen1);
    const gen2 = fsm.beginRequest("a");
    fsm.onIdle("a", () => order.push("second"), gen2);
    fsm.clearIdleResolver("a", gen1);
    expect(fsm.resolveIdle("a")).toBe(true);
    expect(order).toEqual(["second"]);
  });

  it("Релиз 4: resolveIdle завершает все ожидающие поколения", () => {
    const order: string[] = [];
    const gen1 = fsm.beginRequest("a");
    fsm.onIdle("a", () => order.push("g1"), gen1);
    const gen2 = fsm.beginRequest("a");
    fsm.onIdle("a", () => order.push("g2"), gen2);
    expect(fsm.resolveIdle("a")).toBe(true);
    expect(order).toEqual(["g1", "g2"]);
  });
});
