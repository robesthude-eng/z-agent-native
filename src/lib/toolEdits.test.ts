/**
 * Разбор аргументов инструментов, меняющих файлы.
 *
 * Имена полей отличаются между вариантами runtime payload и между `edit`/`multiedit`.
 * Если разбор промахнётся, карточка молча покажет JSON вместо diff'а — то есть
 * пользователь не увидит, что именно агент поменял в его файле.
 */

import { describe, expect, it } from "vitest";
import { extractToolEdits, extractToolFilePath } from "./toolEdits";

describe("extractToolEdits", () => {
  it("reads a camelCase single edit", () => {
    expect(
      extractToolEdits({
        filePath: "src/a.ts",
        oldString: "const a = 1",
        newString: "const a = 2",
      }),
    ).toEqual([{ oldText: "const a = 1", newText: "const a = 2" }]);
  });

  it("reads a snake_case single edit", () => {
    expect(
      extractToolEdits({ old_string: "before", new_string: "after" }),
    ).toEqual([{ oldText: "before", newText: "after" }]);
  });

  it("reads a multiedit list and skips malformed entries", () => {
    const edits = extractToolEdits({
      filePath: "src/a.ts",
      edits: [
        { oldString: "a", newString: "A" },
        { oldString: "b" },
        null,
        "nonsense",
        { old_string: "c", new_string: "C" },
      ],
    });
    expect(edits).toEqual([
      { oldText: "a", newText: "A" },
      { oldText: "c", newText: "C" },
    ]);
  });

  it("accepts an empty oldString — that is a pure insertion, not a missing field", () => {
    expect(extractToolEdits({ oldString: "", newString: "new line" })).toEqual([
      { oldText: "", newText: "new line" },
    ]);
  });

  it.each<[unknown, string]>([
    [undefined, "no input"],
    [null, "null"],
    ["a string", "non-object"],
    [{ command: "ls -la" }, "a different tool"],
    [{ oldString: "a" }, "missing newString"],
  ])("returns nothing for %s (%s)", (input) => {
    expect(extractToolEdits(input)).toEqual([]);
  });
});

describe("extractToolFilePath", () => {
  it.each([
    [{ filePath: "src/a.ts" }, "src/a.ts"],
    [{ file_path: "src/b.ts" }, "src/b.ts"],
    [{ path: "src/c.ts" }, "src/c.ts"],
    [
      { filePath: "/app/workspace/sessions/ses_x/workspace/deep/d.ts" },
      "deep/d.ts",
    ],
  ])("normalizes %o", (input, expected) => {
    expect(extractToolFilePath(input)).toBe(expected);
  });

  it("prefers filePath over path when both are present", () => {
    expect(extractToolFilePath({ filePath: "a.ts", path: "b.ts" })).toBe(
      "a.ts",
    );
  });

  it("returns null when there is no usable path", () => {
    expect(extractToolFilePath({ command: "ls" })).toBeNull();
    expect(extractToolFilePath({ filePath: "../escape.ts" })).toBeNull();
  });
});
