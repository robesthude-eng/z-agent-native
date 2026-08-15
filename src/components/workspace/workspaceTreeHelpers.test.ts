import { describe, expect, it } from "vitest";
import { filterNodes, toRelPath, toTree } from "./workspaceTreeHelpers";

describe("toRelPath", () => {
  it("strips the per-session workspace prefix", () => {
    expect(
      toRelPath("/app/workspace/sessions/ses_1/workspace/src/main.tsx"),
    ).toBe("src/main.tsx");
  });

  it("maps the session workspace root to '.'", () => {
    expect(toRelPath("/app/workspace/sessions/ses_1/workspace")).toBe(".");
  });

  it("strips the shared workspace prefix", () => {
    expect(toRelPath("/app/workspace/uploads/file.txt")).toBe(
      "uploads/file.txt",
    );
  });

  it("leaves unrelated and empty paths untouched", () => {
    expect(toRelPath("src/main.tsx")).toBe("src/main.tsx");
    expect(toRelPath("")).toBe("");
  });
});

describe("toTree", () => {
  it("nests files under their directories", () => {
    const tree = toTree([
      { path: "src/api/client.ts" },
      { path: "src/main.tsx" },
    ]);

    expect(tree).toHaveLength(1);
    const src = tree[0];
    expect(src?.name).toBe("src");
    expect(src?.isDir).toBe(true);
    expect(src?.children?.map((c) => c.name)).toEqual(["api", "main.tsx"]);
    expect(src?.children?.[0]?.children?.[0]?.path).toBe("src/api/client.ts");
  });

  it("sorts directories before files, then alphabetically", () => {
    const tree = toTree([
      { path: "b.txt" },
      { path: "a.txt" },
      { path: "z-dir", type: "directory" },
    ]);

    expect(tree.map((n) => n.name)).toEqual(["z-dir", "a.txt", "b.txt"]);
  });

  it("honours explicit directory markers and skips empty paths", () => {
    const tree = toTree([
      { path: "" },
      { path: "docs", isDirectory: true },
      { path: "README.md" },
    ]);

    expect(tree.map((n) => [n.name, n.isDir])).toEqual([
      ["docs", true],
      ["README.md", false],
    ]);
  });

  it("deduplicates repeated directory segments", () => {
    const tree = toTree([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(2);
  });
});

describe("filterNodes", () => {
  const options = {
    mySessionIds: new Set(["ses_mine"]),
  };

  it("hides build and secret artefacts at any depth", () => {
    const kept = filterNodes(
      [
        { path: "src/main.tsx" },
        { path: "node_modules/react/index.js" },
        { path: "dist/assets/app.js" },
        { path: ".users.json" },
        { path: ".users.json" },
      ],
      options,
    );

    expect(kept.map((n) => n.path)).toEqual(["src/main.tsx"]);
  });

  it("hides generated .map and .tsbuildinfo files", () => {
    const kept = filterNodes(
      [
        { path: "src/app.js.map" },
        { path: "tsconfig.tsbuildinfo" },
        { path: "src/app.ts" },
      ],
      options,
    );

    expect(kept.map((n) => n.path)).toEqual(["src/app.ts"]);
  });

  it("hides other users' session directories but keeps my own", () => {
    const kept = filterNodes(
      [
        { path: "sessions/ses_mine/workspace" },
        { path: "sessions/ses_other/workspace" },
        { path: "uploads/ses_other/a.png" },
        { path: "uploads/ses_mine/b.png" },
      ],
      options,
    );

    expect(kept.map((n) => n.path)).toEqual([
      "sessions/ses_mine/workspace",
      "uploads/ses_mine/b.png",
    ]);
  });

  it("normalises backslashes and tolerates non-array input", () => {
    expect(
      filterNodes([{ path: "node_modules\\react\\index.js" }], options),
    ).toEqual([]);
    expect(
      filterNodes(undefined as unknown as { path: string }[], options),
    ).toEqual([]);
  });
});
