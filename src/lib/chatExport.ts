import type { Message } from "../api/types";
import { stripAttachmentMarkup } from "./attachments";

/** Текст сообщения без вывода инструментов и рассуждений — для экспорта. */
function visibleText(m: Message): string {
  return (m.parts ?? [])
    .map((p) => {
      if ((p as Record<string, unknown>).synthetic === true) return "";
      if (p.type === "text" && "text" in p && typeof p.text === "string")
        return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function chatToMarkdown(title: string, messages: Message[]): string {
  const lines = [`# ${title || "Чат"}`, ""];
  for (const m of messages) {
    if (m.role === "system") continue;
    const text = stripAttachmentMarkup(visibleText(m));
    if (!text) continue;
    const when = m.time?.created
      ? ` · ${new Date(m.time.created).toLocaleString()}`
      : "";
    lines.push(`## ${m.role === "user" ? "Вы" : "Агент"}${when}`, "", text, "");
  }
  return lines.join("\n");
}

export function downloadText(
  filename: string,
  text: string,
  mime = "text/markdown",
) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string) {
  return (
    (name || "chat")
      .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
      .trim()
      .slice(0, 80) || "chat"
  );
}
