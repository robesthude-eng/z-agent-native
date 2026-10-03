import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./markdownBlocks";

describe("splitMarkdownBlocks", () => {
  it("splits paragraphs and keeps text intact", () => {
    const text = "# Title\n\nFirst para\nline two\n\nSecond";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.length).toBe(3);
    expect(blocks.join("\n")).toBe(text);
  });
  it("does not split inside code fences", () => {
    const text = "Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain("const b = 2;");
  });
  it("keeps indented continuation with its list item", () => {
    const text = "- item\n\n  continued\n\nNext";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks[0]).toContain("continued");
  });
  it("returns whole text when reference definitions exist", () => {
    const text = "See [x]\n\n[x]: https://example.com";
    expect(splitMarkdownBlocks(text)).toEqual([text]);
  });
});
