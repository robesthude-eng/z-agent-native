/**
 * Пути файлов, приходящие из чата, — от агента, из вывода инструментов и из
 * служебных 📎-строк. Все они должны сводиться к одному виду: путь
 * относительно корня воркспейса сессии, потому что именно его понимают
 * `/api/workspace/*` и панель Files.
 *
 * Держим правило в одном месте: раньше та же нормализация была скопирована в
 * MessageItem и в api/client, и любая правка требовала помнить про обе копии.
 */

/**
 * Привести путь к виду, относительному корня воркспейса.
 * Возвращает null, если это не путь внутри воркспейса (URL, traversal, пусто).
 */
export function toWorkspaceRelPath(value: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Агент часто оборачивает пути бэктиками/кавычками в тексте («📎 x →
  // `src/a.ts`»). Раньше обёртка ехала в URL /api/workspace/* как есть и
  // скачивание падало с ENOENT — снимаем её до нормализации.
  const unwrapped = trimmed.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  if (!unwrapped) return null;
  // file:// снимается (так агент ссылается на файл воркспейса), остальные схемы
  // отбрасываются ниже — http(s)://, ws:// и прочее файлами не являются.
  const path = unwrapped
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/^\/app\/workspace\/sessions\/[^/]+\/workspace\//, "")
    .replace(/^\/session\/workspace\//, "")
    .replace(/^sessions\/[^/]+\/workspace\//, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!path) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  if (path.split("/").includes("..")) return null;
  return path;
}

/**
 * Похоже ли содержимое инлайн-кода в ответе агента на путь к файлу, по которому
 * стоит предлагать переход.
 *
 * Требуем расширение: без него `src/components` и `npm run build` не отличить,
 * а ложная кнопка «открыть» раздражает сильнее, чем пропущенная.
 */
export function looksLikeWorkspacePath(value: string): boolean {
  const trimmed = value
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "");
  if (!trimmed || trimmed.length > 200) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  // Расширение в конце последнего сегмента. Предел в 10 символов, а не в 5:
  // «.env.example» и «.gitattributes» — реальные файлы, по которым кликают.
  const last = trimmed.split("/").pop() ?? "";
  if (!/^[\w.@+-]+\.[a-z0-9]{1,10}$/i.test(last)) return false;
  // Точка в начале имени без остального расширения (".env") — это файл,
  // но одиночное ".." или "." путём не считается.
  if (last === "." || last === "..") return false;
  return true;
}
