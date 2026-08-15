// Релиз 5: тесты централизованной отмены HTTP-запросов (Релиз 4, батч 4a).
import { describe, expect, it } from "vitest";
import {
  abortSessionRequests,
  isAbortError,
  sessionSignal,
} from "./abortRegistry";

describe("abortRegistry", () => {
  it("возвращает один и тот же сигнал, пока сессия не оборвана", () => {
    const a = sessionSignal("ses_same");
    const b = sessionSignal("ses_same");
    expect(a).toBe(b);
    expect(a.aborted).toBe(false);
  });

  it("у разных сессий независимые сигналы", () => {
    const a = sessionSignal("ses_ind_a");
    const b = sessionSignal("ses_ind_b");
    expect(a).not.toBe(b);
    abortSessionRequests("ses_ind_a");
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
  });

  it("abortSessionRequests обрывает текущий сигнал сессии", () => {
    const s = sessionSignal("ses_abort");
    abortSessionRequests("ses_abort");
    expect(s.aborted).toBe(true);
  });

  it("после abort выдаётся свежий сигнал — «Стоп» не ломает следующий send", () => {
    const s1 = sessionSignal("ses_fresh");
    abortSessionRequests("ses_fresh");
    const s2 = sessionSignal("ses_fresh");
    expect(s2).not.toBe(s1);
    expect(s2.aborted).toBe(false);
  });

  it("abort неизвестной сессии — no-op", () => {
    expect(() => abortSessionRequests("ses_unknown")).not.toThrow();
  });

  it("isAbortError распознаёт только отмену, не сбои сети", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("network down"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
