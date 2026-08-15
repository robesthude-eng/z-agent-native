/**
 * Решения о файле воркспейса: правится ли, чем показывается, куда ведёт превью.
 *
 * Этап 3.1. Всё это жило приватными функциями внутри `Workspace.tsx` — файла в
 * 1111 строк, который не поднимается ни одним тестом. Функции были чистыми и
 * тогда, но не экспортировались, то есть проверить их было нельзя: та же
 * форма, что у `capabilityGate` до вынесения.
 *
 * Разделение самого компонента (дерево, операции, редактор, диффы) — движение
 * разметки, и оно проверяется только чтением. Здесь то, что проверяется
 * иначе.
 *
 * Поведение переписано с оригинала один в один. Единственное, что добавлено, —
 * причина отказа словами: правило «неактивная кнопка всегда объясняет причину»
 * уже принято для runtime-возможностей (I-31), и редактор не повод его
 * нарушать.
 */

/** Почему файл не редактируется. `null` — редактируется. */
export type ReadonlyReason = "binary" | null;

export interface Editability {
  editable: boolean;
  reason: ReadonlyReason;
  /** Текст для пользователя. Пусто ровно тогда, когда файл редактируется. */
  explanation: string;
}

/** Каждый текстовый файл текущего workspace редактируем; бинарный — только просматриваем/скачиваем. */
export function editability(
  _path: string,
  content?: string | null,
): Editability {
  if (typeof content === "string" && content.includes("\u0000")) {
    return {
      editable: false,
      reason: "binary",
      explanation: "Двоичный файл: сохранение испортило бы содержимое",
    };
  }
  return { editable: true, reason: null, explanation: "" };
}

export type PreviewKind = "image" | "html" | "svg" | "markdown";
export type ViewMode = "code" | "preview" | "diff";

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "avif",
]);

/** Расширение в нижнем регистре, без точки. Пусто, если его нет. */
export function extOf(path: string): string {
  return /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
}

/** Что из файла можно показать глазами, а не текстом. */
export function previewKind(path: string): PreviewKind | null {
  const ext = extOf(path);
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "svg") return "svg";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  return null;
}

/**
 * Какие вкладки доступны для файла.
 *
 * Набор НИКОГДА не пуст, и это главное его свойство: панель с нулём режимов
 * показывала бы пустоту вместо файла, причём тем чаще, чем незнакомее
 * расширение. `code` есть всегда — даже у двоичного файла, где он покажет,
 * что смотреть нечем, а не спрячет сам файл.
 */
export function viewModesFor(
  path: string,
  opts: { hasDiff?: boolean } = {},
): ViewMode[] {
  const modes: ViewMode[] = ["code"];
  if (previewKind(path)) modes.push("preview");
  if (opts.hasDiff) modes.push("diff");
  return modes;
}

/**
 * Остаётся ли выбранный режим годным после смены файла.
 *
 * Переключаться молча нельзя в обе стороны: оставить `preview` на файле без
 * превью — пустая панель, а сбрасывать в `code` при каждой смене файла —
 * потеря выбора там, где он был осмыслен.
 */
export function keepViewMode(
  current: ViewMode,
  available: ViewMode[],
): ViewMode {
  return available.includes(current) ? current : "code";
}

/** Имя родительской папки пути: `src/lib/a.ts` → `src/lib`. */
export function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * URL превью конкретного файла воркспейса.
 *
 * Маркер `~` после идентификатора сессии переключает превью-роут в режим
 * «корень = воркспейс» (`server/preview.mjs`): без него путь резолвится
 * относительно автоопределённого docroot (`dist/` и подобных), и файл из
 * другой папки не нашёлся бы. Относительные ссылки внутри страницы остаются в
 * том же режиме, потому что маркер живёт в пути, а не в query.
 *
 * **Обход каталогов здесь НЕ отсекается, и это не упущение.** `..` — законная
 * последовательность для `encodeURIComponent`, и «почистить» её на клиенте
 * значило бы завести вторую границу безопасности рядом с настоящей. Настоящая
 * — `buildSafeWorkspacePath` на сервере (I-02), и она закрыта тестом. Клиент,
 * который сам себе охрана, создаёт ровно ту иллюзию, из-за которой серверную
 * проверку однажды сочтут лишней.
 */
export function workspacePreviewUrl(path: string, sessionId: string): string {
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/api/sandbox-proxy/${encodeURIComponent(sessionId)}/~/${encoded}`;
}
