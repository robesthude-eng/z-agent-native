/**
 * Построчный diff.
 *
 * Diff читают, чтобы решить «принять правку агента или нет», поэтому цена
 * ошибки — не косметика: сдвинутые номера строк или потерянная строка приводят
 * к неверному решению о чужом изменении файла.
 */

import { describe, expect, it } from "vitest";
import { diffLines, diffStatLabel } from "./diff";

const text = (...lines: string[]) => lines.join("\n");

describe("diffLines", () => {
  it("returns no hunks for identical text", () => {
    const res = diffLines("a\nb\nc", "a\nb\nc");
    expect(res.hunks).toEqual([]);
    expect(res.added).toBe(0);
    expect(res.removed).toBe(0);
  });

  it("ignores a trailing newline difference only in the last empty line", () => {
    // "a\nb\n" и "a\nb" — один и тот же файл с точки зрения содержимого строк.
    expect(diffLines("a\nb\n", "a\nb").hunks).toEqual([]);
  });

  it("normalizes CRLF so a Windows checkout is not a whole-file diff", () => {
    expect(diffLines("a\r\nb\r\nc", "a\nb\nc").hunks).toEqual([]);
  });

  it("marks a single changed line as one deletion and one addition", () => {
    const res = diffLines(
      text("one", "two", "three"),
      text("one", "TWO", "three"),
    );
    expect(res.added).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.hunks).toHaveLength(1);

    const ops = res.hunks[0]?.lines.map((l) => [l.op, l.text]);
    expect(ops).toEqual([
      ["ctx", "one"],
      ["del", "two"],
      ["add", "TWO"],
      ["ctx", "three"],
    ]);
  });

  it("keeps line numbers aligned to each side", () => {
    const res = diffLines(text("a", "b", "c"), text("a", "b2", "b3", "c"));
    const rows = res.hunks[0]?.lines.map((l) => [l.op, l.oldNo, l.newNo]);
    expect(rows).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["ctx", 3, 4],
    ]);
  });

  it("splits distant edits into separate hunks and collapses the gap", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[1] = "CHANGED TOP";
    after[38] = "CHANGED BOTTOM";

    const res = diffLines(before.join("\n"), after.join("\n"), { context: 2 });
    expect(res.hunks).toHaveLength(2);
    // Свёрнутая середина не попадает в вывод: 2 строки контекста с каждой
    // стороны + сама правка, а не все 40 строк файла.
    expect(res.hunks[0]?.lines.length).toBeLessThanOrEqual(6);
    expect(res.hunks[1]?.lines.length).toBeLessThanOrEqual(6);
    expect(res.hunks[1]?.lines.some((l) => l.text === "CHANGED BOTTOM")).toBe(
      true,
    );
  });

  it("handles pure insertion into an empty file", () => {
    const res = diffLines("", text("hello", "world"));
    expect(res.removed).toBe(0);
    expect(res.added).toBe(2);
    expect(res.hunks[0]?.lines.every((l) => l.op === "add")).toBe(true);
  });

  it("handles full deletion", () => {
    const res = diffLines(text("hello", "world"), "");
    expect(res.added).toBe(0);
    expect(res.removed).toBe(2);
  });

  it("falls back to a block diff instead of a quadratic blow-up", () => {
    const before = Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 50 }, (_, i) => `b${i}`).join("\n");

    const res = diffLines(before, after, { maxLcsLines: 10 });
    expect(res.truncated).toBe(true);
    expect(res.removed).toBe(50);
    expect(res.added).toBe(50);
  });

  it("does not mark unchanged head and tail as changed on a big file", () => {
    const head = Array.from({ length: 2000 }, (_, i) => `h${i}`);
    const tail = Array.from({ length: 2000 }, (_, i) => `t${i}`);
    const before = [...head, "middle", ...tail].join("\n");
    const after = [...head, "MIDDLE", ...tail].join("\n");

    // Срезка общего начала и конца оставляет LCS одну строку — предел не задет.
    const res = diffLines(before, after);
    expect(res.truncated).toBe(false);
    expect(res.added).toBe(1);
    expect(res.removed).toBe(1);
    expect(res.hunks).toHaveLength(1);
  });
});

describe("diffStatLabel", () => {
  it("formats the counters", () => {
    expect(diffStatLabel({ added: 12, removed: 3 })).toBe("+12 −3");
  });
});
