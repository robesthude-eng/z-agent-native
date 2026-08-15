import hljs from "highlight.js/lib/common";
import { describe, expect, it } from "vitest";
import {
  codeLanguage,
  HIGHLIGHT_MAX_CHARS,
  highlightLanguage,
} from "./codeLanguage";

/**
 * Каким языком подсвечивать файл.
 *
 * Главная проверка здесь не «json → json», а то, что КАЖДЫЙ язык из таблицы
 * действительно зарегистрирован в common-сборке highlight.js. Опечатка или
 * язык из полной сборки не дали бы ошибки: hljs молча подсветил бы файл как
 * простой текст, и заметить это можно было бы только глазами.
 */

const NAMES = [
  "app.ts",
  "app.tsx",
  "server.mjs",
  "package.json",
  "index.html",
  "icon.svg",
  "styles.css",
  "theme.scss",
  "docker-compose.yml",
  "config.toml",
  "script.py",
  "main.go",
  "lib.rs",
  "Main.java",
  "app.rb",
  "query.sql",
  "deploy.sh",
  "README.md",
  "change.diff",
  "Dockerfile",
  "Makefile",
  ".gitignore",
  ".env",
];

describe("каждый заявленный язык есть в сборке", () => {
  it.each(NAMES)("%s", (name) => {
    const lang = codeLanguage(name);
    expect(lang).toBeTruthy();
    // Вот ради чего тест: hljs на незарегистрированный язык не падает, а
    // тихо отдаёт неподсвеченный текст.
    expect(hljs.getLanguage(lang as string)).toBeTruthy();
  });
});

describe("сопоставление", () => {
  it.each([
    ["app.ts", "typescript"],
    ["app.jsx", "javascript"],
    ["package.json", "json"],
    ["page.html", "xml"],
    ["logo.svg", "xml"],
    ["conf.yml", "yaml"],
    ["deploy.sh", "bash"],
  ])("%s → %s", (name, lang) => {
    expect(codeLanguage(name)).toBe(lang);
  });

  it("работает и с полным путём, а не только с именем", () => {
    expect(codeLanguage("/app/workspace/src/main.ts")).toBe("typescript");
    expect(codeLanguage("server/routes/session.mjs")).toBe("javascript");
  });

  it("регистр не важен", () => {
    expect(codeLanguage("APP.TS")).toBe("typescript");
    expect(codeLanguage("DOCKERFILE")).toBe("bash");
  });
});

describe("неизвестное — null, а не выдумка", () => {
  it.each(["notes.qqq", "blob.bin", "file", "", "/"])("%s", (name) => {
    expect(codeLanguage(name)).toBeNull();
  });

  it("файл без подсветки — нормальный исход", () => {
    // Вызывающий обязан уметь показать текст как есть; null это и означает.
    expect(codeLanguage("data.unknown")).toBeNull();
  });
});

describe("огромные файлы не подсвечиваются", () => {
  it("до потолка — подсвечиваем", () => {
    expect(highlightLanguage("app.ts", "x".repeat(1000))).toBe("typescript");
    expect(highlightLanguage("app.ts", "x".repeat(HIGHLIGHT_MAX_CHARS))).toBe(
      "typescript",
    );
  });

  it("выше потолка — отказ, даже если язык известен", () => {
    // Разбор синхронный: на таком файле окно замерло бы на видимую паузу.
    expect(
      highlightLanguage("app.ts", "x".repeat(HIGHLIGHT_MAX_CHARS + 1)),
    ).toBeNull();
  });

  it("пустое содержимое не ломает проверку", () => {
    expect(highlightLanguage("app.ts", "")).toBe("typescript");
  });
});
