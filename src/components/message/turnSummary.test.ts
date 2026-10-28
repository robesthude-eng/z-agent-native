import { describe, expect, it } from "vitest";
import type { Message } from "../../api/types";
import { assistantTurnSummary, patchChangedFiles } from "./turnSummary";

const codexPatch = [
  "*** Begin Patch",
  "*** Add File: docs/new.md",
  "+++ not a diff header, just added text",
  "*** Update File: src/a.ts",
  "@@",
  "-a",
  "+b",
  "*** Update File: src/old-name.ts",
  "*** Move to: src/new-name.ts",
  "@@",
  "-x",
  "+y",
  "*** Delete File: src/gone.ts",
  '*** Update File: "src/with space.ts"',
  "@@",
  "-p",
  "+q",
  "*** End Patch",
].join("\n");

describe("patchChangedFiles", () => {
  it("lists the files that exist after a *** Begin Patch patch", () => {
    expect(patchChangedFiles(codexPatch)).toEqual([
      "docs/new.md",
      "src/a.ts",
      "src/new-name.ts",
      '"src/with space.ts"',
    ]);
  });

  it("understands the patch inside a shell heredoc and with CRLF line breaks", () => {
    const wrapped = `apply_patch <<'EOF'\r\n${codexPatch.replaceAll("\n", "\r\n")}\r\nEOF`;
    expect(patchChangedFiles(wrapped)).toContain("src/new-name.ts");
    expect(patchChangedFiles(wrapped)).toContain("src/a.ts");
  });

  it("still reads unified diffs", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+world",
      "--- a/gone.txt",
      "+++ /dev/null",
    ].join("\n");
    expect(patchChangedFiles(diff)).toEqual(["a.txt"]);
  });
});

describe("assistantTurnSummary changed files", () => {
  it("collects files from both patch formats", () => {
    const part = (callID: string, patch: string) => ({
      type: "tool",
      tool: "apply_patch",
      callID,
      state: { status: "completed", input: { patch } },
    });
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          part("c1", codexPatch),
          part("c2", "--- a/z.txt\n+++ b/z.txt\n@@ -1 +1 @@\n-1\n+2\n"),
        ],
      },
    ] as unknown as Message[];
    expect(assistantTurnSummary(messages).changedFiles).toEqual([
      "docs/new.md",
      "src/a.ts",
      "src/new-name.ts",
      "src/with space.ts",
      "z.txt",
    ]);
  });
});
