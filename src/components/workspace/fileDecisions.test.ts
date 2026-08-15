/**
 * Этап 3.1: решения о файле воркспейса.
 *
 * Перебор, а не случаи. Два свойства держат панель от пустоты: набор режимов
 * никогда не пуст, и всякий отказ в правке назван словами.
 */
import { describe, expect, it } from "vitest";
import {
  editability,
  extOf,
  keepViewMode,
  parentDir,
  previewKind,
  type ViewMode,
  viewModesFor,
  workspacePreviewUrl,
} from "@/components/workspace/fileDecisions";

const PATHS = [
  "a.ts",
  "src/lib/a.ts",
  "README.md",
  "docs/guide.markdown",
  "logo.png",
  "logo.SVG",
  "page.html",
  "page.htm",
  "archive.tar.gz",
  "Makefile",
  "project",
  "project/src/main.tsx",
  ".env.example",
  "путь/с/кириллицей.txt",
  "",
];

describe("правится ли файл", () => {
  it("обычный файл правится и причины не называет", () => {
    const e = editability("src/lib/a.ts", "текст");
    expect(e.editable).toBe(true);
    expect(e.reason).toBeNull();
    expect(e.explanation).toBe("");
  });

  it("любой текстовый файл текущего workspace можно редактировать", () => {
    for (const p of ["project", "project/src/main.tsx", ".env.example"]) {
      expect(editability(p, "текст").editable).toBe(true);
    }
  });

  it("двоичное содержимое не правится", () => {
    expect(editability("data.bin", "перед\u0000после").reason).toBe("binary");
  });

  it("двоичность определяется содержимым после чтения", () => {
    expect(editability("project/src/a.ts").editable).toBe(true);
    expect(editability("project/src/a.ts", "\u0000").reason).toBe("binary");
  });

  // То же требование, что I-31 предъявляет к неактивной кнопке: молчаливого
  // отказа нет ни одного.
  it("всякий отказ назван словами", () => {
    const denied = [editability("bin", "\u0000")];
    for (const d of denied) {
      expect(d.editable).toBe(false);
      expect(d.explanation.length).toBeGreaterThan(10);
    }
  });

  it("объяснение есть ровно там, где отказ", () => {
    for (const p of PATHS) {
      const e = editability(p, "текст");
      expect(`${p}:${e.explanation !== ""}`).toBe(`${p}:${!e.editable}`);
    }
  });
});

describe("чем показывается файл", () => {
  it("вид превью выводится по расширению без учёта регистра", () => {
    expect(previewKind("logo.SVG")).toBe("svg");
    expect(previewKind("A.PNG")).toBe("image");
  });

  it("незнакомое расширение превью не имеет", () => {
    expect(previewKind("archive.tar.gz")).toBeNull();
    expect(previewKind("Makefile")).toBeNull();
  });

  it("расширение берётся последнее", () => {
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("Makefile")).toBe("");
    expect(extOf("")).toBe("");
  });

  // Главное свойство: панель не может остаться без единой вкладки.
  it("набор режимов никогда не пуст", () => {
    for (const p of PATHS) {
      for (const hasDiff of [true, false]) {
        const modes = viewModesFor(p, { hasDiff });
        expect(`${p}/${hasDiff}: ${modes.length > 0}`).toBe(
          `${p}/${hasDiff}: true`,
        );
        expect(modes).toContain("code");
      }
    }
  });

  it("превью появляется ровно у файлов с видом превью", () => {
    for (const p of PATHS) {
      const has = viewModesFor(p).includes("preview");
      expect(`${p}:${has}`).toBe(`${p}:${previewKind(p) !== null}`);
    }
  });

  it("диффа нет, пока его не передали", () => {
    expect(viewModesFor("a.ts")).not.toContain("diff");
    expect(viewModesFor("a.ts", { hasDiff: true })).toContain("diff");
  });
});

describe("режим переживает смену файла, если остаётся годным", () => {
  const ALL: ViewMode[] = ["code", "preview", "diff"];

  it("годный режим сохраняется", () => {
    expect(keepViewMode("preview", ["code", "preview"])).toBe("preview");
  });

  it("негодный сбрасывается в code, а не в пустоту", () => {
    expect(keepViewMode("preview", ["code"])).toBe("code");
    expect(keepViewMode("diff", ["code", "preview"])).toBe("code");
  });

  it("результат всегда доступен", () => {
    for (const current of ALL) {
      for (const available of [["code"], ["code", "preview"], ALL]) {
        const kept = keepViewMode(current, available as ViewMode[]);
        expect(`${current}->${kept}`).toBe(
          `${current}->${available.includes(current) ? current : "code"}`,
        );
        expect(available).toContain(kept);
      }
    }
  });
});

describe("путь и ссылка превью", () => {
  it("родительская папка", () => {
    expect(parentDir("src/lib/a.ts")).toBe("src/lib");
    expect(parentDir("a.ts")).toBe("");
    expect(parentDir("")).toBe("");
  });

  it("маркер ~ стоит после идентификатора сессии", () => {
    // Без маркера путь резолвится относительно docroot, и файл из другой
    // папки не нашёлся бы.
    expect(workspacePreviewUrl("a.txt", "ses_1")).toBe(
      "/api/sandbox-proxy/ses_1/~/a.txt",
    );
  });

  it("сегменты кодируются по отдельности, разделители остаются", () => {
    expect(workspacePreviewUrl("папка/имя файла.txt", "ses_1")).toBe(
      `/api/sandbox-proxy/ses_1/~/${encodeURIComponent("папка")}/${encodeURIComponent("имя файла.txt")}`,
    );
  });

  it("пустые сегменты выбрасываются", () => {
    expect(workspacePreviewUrl("//a//b//", "s")).toBe(
      "/api/sandbox-proxy/s/~/a/b",
    );
  });

  // Зафиксировано намеренно: клиент обход каталогов НЕ отсекает. Настоящая
  // граница — `buildSafeWorkspacePath` на сервере (I-02). Вторая проверка
  // здесь создала бы иллюзию, из-за которой серверную однажды сочтут лишней.
  it("`..` доходит до сервера как есть — граница там, а не тут", () => {
    expect(workspacePreviewUrl("../secret", "s")).toBe(
      "/api/sandbox-proxy/s/~/../secret",
    );
  });
});
