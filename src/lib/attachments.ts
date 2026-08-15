import { formatSize } from "../api/files";

/**
 * Разбор ссылок на вложения в тексте. Новый native protocol передаёт
 * пользовательские файлы отдельными `attachment` parts; блок
 * <attachments> оставлен здесь только для чтения старых экспортов/историй.
 *
 * Агент → UI по-прежнему может вывести строки «📎 имя → путь». Этот формат задан в
 *    server/system-instruction.txt и менять его нельзя — модель уже
 *    обучена им пользоваться, и так приходят созданные ею артефакты.
 *
 * Обе формы разбираются в один тип AttachmentRef, поэтому рендер чипов
 * не знает, откуда пришла ссылка.
 */

export interface AttachmentRef {
  /** Имя для показа. Каноническое — то, что назначил сервер. */
  name: string;
  /** Путь относительно корня workspace сессии, например uploads/отчёт.pdf. */
  path: string;
  /** Размер в байтах, если известен. */
  size?: number;
  /** Уточнение для модели и подпись в чипе («zip-архив, 14 файлов»). */
  note?: string;
}

const BLOCK_OPEN = "<attachments>";
const BLOCK_CLOSE = "</attachments>";
const ARROW = " → ";
const META = " · ";

/** Строка формата агента: «📎 имя → путь …». */
const AGENT_LINE_RE = /^📎 (.+?) → (\S+)(.*)$/;

/** Legacy serializer kept only for compatibility tests/imports. Native sends typed attachment parts. */
export function buildAttachmentManifest(refs: AttachmentRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((r) => {
    const meta: string[] = [];
    if (typeof r.size === "number") meta.push(formatSize(r.size));
    if (r.note) meta.push(r.note);
    return `- ${r.name}${ARROW}${r.path}${meta.length ? META + meta.join(META) : ""}`;
  });
  return [
    BLOCK_OPEN,
    "Файлы приложены пользователем и уже лежат в workspace этого чата.",
    "Обращайся к ним по указанным относительным путям.",
    ...lines,
    BLOCK_CLOSE,
  ].join("\n");
}

/** Разбор одной строки манифеста: «- имя → путь · 2.1 MB · заметка». */
function parseManifestLine(line: string): AttachmentRef | null {
  const body = line.replace(/^-\s+/, "").trim();
  const arrow = body.indexOf(ARROW);
  if (arrow === -1) return null;
  const name = body.slice(0, arrow).trim();
  const tail = body.slice(arrow + ARROW.length);
  if (!name || !tail) return null;
  const [pathPart, ...metaParts] = tail.split(META);
  const path = (pathPart ?? "").trim();
  if (!path) return null;
  // Размер печатался formatSize — как заметку его не показываем.
  const note = metaParts
    .map((m) => m.trim())
    .filter((m) => m && !/^[\d.]+\s*(B|KB|MB)$/i.test(m))
    .join(META);
  return note ? { name, path, note } : { name, path };
}

/**
 * Вырезает манифест из текста сообщения.
 * Возвращает найденные ссылки и текст без блока.
 */
export function parseAttachmentManifest(text: string): {
  refs: AttachmentRef[];
  rest: string;
} {
  const start = text.indexOf(BLOCK_OPEN);
  if (start === -1) return { refs: [], rest: text };
  const end = text.indexOf(BLOCK_CLOSE, start);
  if (end === -1) return { refs: [], rest: text };

  const inner = text.slice(start + BLOCK_OPEN.length, end);
  const refs: AttachmentRef[] = [];
  for (const line of inner.split("\n")) {
    if (!line.trim().startsWith("-")) continue; // пояснения для модели
    const ref = parseManifestLine(line);
    if (ref) refs.push(ref);
  }
  const rest = (text.slice(0, start) + text.slice(end + BLOCK_CLOSE.length))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { refs, rest };
}

/** Вырезает строки «📎 имя → путь» — артефакты, созданные агентом. */
export function parseAgentAttachmentLines(text: string): {
  refs: AttachmentRef[];
  rest: string;
} {
  if (!text.includes("📎")) return { refs: [], rest: text };
  const refs: AttachmentRef[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const m = AGENT_LINE_RE.exec(line.trim());
    if (!m) {
      kept.push(line);
      continue;
    }
    const name = m[1] ?? "";
    const path = m[2] ?? "";
    const note = (m[3] ?? "").replace(/^[\s—-]+/, "").trim();
    refs.push(note ? { name, path, note } : { name, path });
  }
  if (refs.length === 0) return { refs: [], rest: text };
  return { refs, rest: kept.join("\n").trim() };
}

/**
 * Оба формата разом — рендеру всё равно, кто автор ссылки.
 * Дубли по одному и тому же пути схлопываются.
 */
export function extractAttachments(text: string): {
  refs: AttachmentRef[];
  rest: string;
} {
  const manifest = parseAttachmentManifest(text);
  const agent = parseAgentAttachmentLines(manifest.rest);
  const seen = new Set<string>();
  const refs: AttachmentRef[] = [];
  for (const r of [...manifest.refs, ...agent.refs]) {
    const key = r.path || r.name;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(r);
  }
  return { refs, rest: agent.rest };
}

/** Текст сообщения без служебных блоков — для копирования, экспорта, правки. */
export function stripAttachmentMarkup(text: string): string {
  return extractAttachments(text).rest;
}
