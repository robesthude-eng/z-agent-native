import { describe, expect, it } from "vitest";
import { fileVisual } from "./fileVisual";

/**
 * Как файл выглядит в дереве воркспейса.
 *
 * До этого все файлы рисовались одним серым значком, и `package.json`,
 * скриншот и `index.tsx` были неотличимы. Проверяется не «цвет такой-то», а
 * то, ради чего различие заводилось: похожие по смыслу файлы попадают в одно
 * семейство, непохожие — в разные, а неизвестное не притворяется известным.
 */

describe("узнаваемые типы", () => {
  it.each([
    ["package.json", "config"],
    ["tsconfig.json", "config"],
    ["docker-compose.yml", "config"],
    ["vite.config.ts", "typed"],
    ["index.tsx", "typed"],
    ["server.mjs", "script"],
    ["index.html", "markup"],
    ["styles.css", "style"],
    ["README.md", "doc"],
    ["logo.png", "image"],
    ["backup.zip", "archive"],
    ["deploy.sh", "shell"],
    ["users.csv", "data"],
  ])("%s → %s", (name, family) => {
    expect(fileVisual(name).family).toBe(family);
  });
});

describe("файлы без расширения", () => {
  it("узнаются по полному имени", () => {
    expect(fileVisual("Dockerfile").family).toBe("shell");
    expect(fileVisual("Makefile").family).toBe("shell");
  });

  it("регистр не важен: для человека Dockerfile и dockerfile — одно и то же", () => {
    expect(fileVisual("dockerfile").family).toBe("shell");
    expect(fileVisual("DOCKERFILE").family).toBe("shell");
  });

  it("точечные файлы не уходят в «неизвестное»", () => {
    // У `.gitignore` расширение формально «gitignore»; без проверки по
    // полному имени он попал бы в plain и выглядел бы как мусор.
    expect(fileVisual(".gitignore").family).toBe("config");
    expect(fileVisual(".env").family).toBe("config");
    expect(fileVisual(".editorconfig").family).toBe("config");
  });
});

describe("значок отличается только там, где это осмысленно", () => {
  it("картинки и архивы получают свой значок", () => {
    expect(fileVisual("photo.jpg").glyph).toBe("image");
    expect(fileVisual("dump.tar").glyph).toBe("archive");
  });

  it("остальные — обычный лист, различаются цветом", () => {
    expect(fileVisual("main.ts").glyph).toBe("file");
    expect(fileVisual("package.json").glyph).toBe("file");
    expect(fileVisual("readme.md").glyph).toBe("file");
  });
});

describe("неизвестное не притворяется известным", () => {
  it.each(["notes.qqq", "binary.bin", "file", ""])("%s → plain", (name) => {
    expect(fileVisual(name).family).toBe("plain");
  });

  it("plain приглушён, а не выкрашен наравне с остальными", () => {
    // Файл без узнаваемого типа не должен притягивать взгляд.
    expect(fileVisual("notes.qqq").color).toContain("muted");
  });
});

describe("устойчивость", () => {
  it("регистр расширения не важен", () => {
    expect(fileVisual("IMAGE.PNG").family).toBe("image");
    expect(fileVisual("Config.JSON").family).toBe("config");
  });

  it("пробелы по краям не мешают", () => {
    expect(fileVisual("  app.tsx  ").family).toBe("typed");
  });

  it("составное расширение читается по последней части", () => {
    expect(fileVisual("archive.tar.gz").family).toBe("archive");
    expect(fileVisual("component.test.ts").family).toBe("typed");
  });

  it("цвет всегда задан", () => {
    for (const n of ["a.ts", "b.qqq", "", "Dockerfile", "x.png"]) {
      expect(fileVisual(n).color).toBeTruthy();
    }
  });
});
