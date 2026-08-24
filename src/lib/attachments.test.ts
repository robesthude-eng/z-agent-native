import { describe, expect, it } from "vitest";
import {
  buildAttachmentManifest,
  extractAttachments,
  parseAgentAttachmentLines,
  parseAttachmentManifest,
  stripAttachmentMarkup,
} from "./attachments";

describe("buildAttachmentManifest", () => {
  it("пустой список — пустая строка (в промпт ничего не уходит)", () => {
    expect(buildAttachmentManifest([])).toBe("");
  });

  it("собирается и разбирается обратно без потерь", () => {
    const refs = [
      { name: "отчёт.pdf", path: "uploads/отчёт.pdf", size: 2_200_000 },
      {
        name: "b.zip",
        path: "uploads/b.zip",
        size: 100,
        note: "zip-архив, 3 файлов, ещё не распакован",
      },
    ];
    const parsed = parseAttachmentManifest(buildAttachmentManifest(refs));
    expect(parsed.refs).toEqual([
      { name: "отчёт.pdf", path: "uploads/отчёт.pdf" },
      {
        name: "b.zip",
        path: "uploads/b.zip",
        note: "zip-архив, 3 файлов, ещё не распакован",
      },
    ]);
  });
});

describe("parseAttachmentManifest", () => {
  it("вырезает блок и оставляет текст пользователя", () => {
    const text = `посмотри файл\n\n${buildAttachmentManifest([
      { name: "a.txt", path: "uploads/a.txt" },
    ])}`;
    const { refs, rest } = parseAttachmentManifest(text);
    expect(refs).toHaveLength(1);
    expect(rest).toBe("посмотри файл");
  });

  it("текст пользователя со стрелкой не превращается во вложение", () => {
    // Прежний разбор шёл регуляркой по всему сообщению, поэтому строку,
    // похожую на служебную, он забирал себе. Блок этого не допускает.
    const text = "переименуй old.txt → new.txt и покажи диф";
    expect(parseAttachmentManifest(text).refs).toEqual([]);
    expect(parseAttachmentManifest(text).rest).toBe(text);
  });

  it("незакрытый блок игнорируется целиком", () => {
    const text = "текст\n<attachments>\n- a.txt → uploads/a.txt";
    expect(parseAttachmentManifest(text).refs).toEqual([]);
  });
});

describe("parseAgentAttachmentLines", () => {
  it("разбирает формат артефактов агента", () => {
    const { refs, rest } = parseAgentAttachmentLines(
      "Готово.\n📎 report.pdf → out/report.pdf — итоговый отчёт",
    );
    expect(refs).toEqual([
      { name: "report.pdf", path: "out/report.pdf", note: "итоговый отчёт" },
    ]);
    expect(rest).toBe("Готово.");
  });

  it("показывает настоящее имя файла, а не придуманное описание", () => {
    // Агент вписывал вместо имени человеческое описание. Пользователь в чипе
    // должен видеть реальное имя сохранённого файла, описание — в подзаголовке.
    const { refs } = parseAgentAttachmentLines(
      "📎 Стили темы → `z-agent-native-main/src/index.css`\n📎 Собранное приложение → z-agent-native-main/dist/index.html",
    );
    expect(refs[0]).toMatchObject({
      name: "index.css",
      path: "z-agent-native-main/src/index.css",
      note: "Стили темы",
    });
    expect(refs[1]).toMatchObject({
      name: "index.html",
      path: "z-agent-native-main/dist/index.html",
      note: "Собранное приложение",
    });
  });
});

describe("extractAttachments", () => {
  it("понимает оба формата разом и схлопывает дубли по пути", () => {
    const text = `итог\n📎 a.txt → uploads/a.txt\n${buildAttachmentManifest([
      { name: "a.txt", path: "uploads/a.txt" },
      { name: "b.bin", path: "uploads/b.bin" },
    ])}`;
    const { refs, rest } = extractAttachments(text);
    expect(refs.map((r) => r.path)).toEqual(["uploads/a.txt", "uploads/b.bin"]);
    expect(rest).toBe("итог");
  });
});

describe("stripAttachmentMarkup", () => {
  it("оставляет только видимый текст", () => {
    const text = `сделай отчёт\n${buildAttachmentManifest([
      { name: "a.txt", path: "uploads/a.txt" },
    ])}`;
    expect(stripAttachmentMarkup(text)).toBe("сделай отчёт");
  });
});
