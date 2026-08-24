/**
 * Нормализация путей из чата.
 *
 * Через эти функции проходит всё, по чему пользователь кликает в ответе агента.
 * Ошибка в одну сторону — «открыть» ведёт в никуда, в другую — кнопка
 * появляется на команде bash или на URL.
 */

import { describe, expect, it } from "vitest";
import { looksLikeWorkspacePath, toWorkspaceRelPath } from "./workspacePath";

describe("toWorkspaceRelPath", () => {
  it.each([
    ["src/app.tsx", "src/app.tsx"],
    ["./src/app.tsx", "src/app.tsx"],
    ["src\\app.tsx", "src/app.tsx"],
    ["/src/app.tsx", "src/app.tsx"],
    ["file:///app/workspace/sessions/ses_a/workspace/src/a.ts", "src/a.ts"],
    ["/app/workspace/sessions/ses_a/workspace/index.html", "index.html"],
    ["sessions/ses_b/workspace/pkg/main.go", "pkg/main.go"],
    ["/session/workspace/notes.md", "notes.md"],
    ["dir/", "dir"],
    // Агент оборачивает пути бэктиками/кавычками в «📎 имя → путь» — раньше
    // обёртка ехала в /api/workspace/download как %60 и сервер отдавал ENOENT.
    ["`src/app.tsx`", "src/app.tsx"],
    ['"src/app.tsx"', "src/app.tsx"],
    ["'src/app.tsx'", "src/app.tsx"],
    ["`z-agent-native-main/dist/index.html`", "z-agent-native-main/dist/index.html"],
  ])("normalizes %s", (input, expected) => {
    expect(toWorkspaceRelPath(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "..",
    "../etc/passwd",
    "src/../../etc/passwd",
  ])("rejects %s", (input) => {
    expect(toWorkspaceRelPath(input)).toBeNull();
  });

  it("rejects remote URLs", () => {
    expect(toWorkspaceRelPath("https://example.com/a.js")).toBeNull();
    expect(toWorkspaceRelPath("ws://localhost:3000/socket")).toBeNull();
  });
});

describe("looksLikeWorkspacePath", () => {
  it.each([
    "src/app.tsx",
    "index.html",
    "package.json",
    ".env.example",
    "pkg/sub/main.go",
    "a/b/c/style.css",
    // Инлайн-код внутри бэктиков — это тот же путь.
    "`src/app.tsx`",
  ])("accepts %s", (input) => {
    expect(looksLikeWorkspacePath(input)).toBe(true);
  });

  it.each([
    "npm run build",
    "src/components",
    "useEffect",
    "https://example.com/a.js",
    "..",
    "",
    // Строка без расширения могла бы быть чем угодно — командой, именем
    // функции, названием папки.
    "Dockerfile",
  ])("rejects %s", (input) => {
    expect(looksLikeWorkspacePath(input)).toBe(false);
  });
});
