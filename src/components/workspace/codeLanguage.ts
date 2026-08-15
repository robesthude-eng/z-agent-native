import { extOf } from "./fileDecisions";

/**
 * Каким языком подсвечивать файл.
 *
 * Отдельно от подсветки намеренно: соответствие «расширение → язык» — это
 * решение, а вызов highlight.js — эффект. Проверить перебором можно только
 * первое.
 *
 * Набор языков ограничен тем, что есть в `highlight.js/lib/common`: полная
 * сборка тянет около двухсот грамматик, и ради `.awk` в дереве воркспейса
 * платить этим весом незачем. Неизвестное расширение отдаёт `null`, и файл
 * показывается без подсветки — это нормальный исход, а не ошибка.
 */

/** Языки, доступные в common-сборке highlight.js и осмысленные здесь. */
const BY_EXT: Record<string, string> = {
  // веб
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "scss",
  less: "less",

  // конфиги
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  env: "ini",

  // языки
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  lua: "lua",
  r: "r",
  pl: "perl",

  // прочее
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

/** Файлы без расширения, у которых язык всё равно известен. */
const BY_NAME: Record<string, string> = {
  dockerfile: "bash",
  makefile: "makefile",
  ".gitignore": "bash",
  ".dockerignore": "bash",
  ".env": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
};

/**
 * @param path путь или имя файла
 * @returns имя языка для highlight.js либо `null`, если подсвечивать нечем
 */
export function codeLanguage(path: string): string | null {
  const name = (path || "").split("/").pop()?.trim().toLowerCase() ?? "";
  if (!name) return null;
  // Полное имя — раньше расширения: у `.gitignore` расширение формально
  // «gitignore», и без этой ветки язык не нашёлся бы.
  return BY_NAME[name] ?? BY_EXT[extOf(name)] ?? null;
}

/**
 * Потолок, выше которого файл показывается без подсветки.
 *
 * Разбор идёт синхронно, в главном потоке: на мегабайтном файле это заметная
 * пауза, во время которой окно не отвечает. Полмиллиона символов — это
 * примерно десять тысяч строк кода; всё, что длиннее, в редакторе воркспейса
 * читают не глазами, а поиском.
 */
export const HIGHLIGHT_MAX_CHARS = 500_000;

/**
 * Подсвечивать ли этот файл.
 *
 * Отказ — нормальный исход, а не ошибка: текст показывается как есть.
 * Возвращает язык (значит «подсвечивать им») либо `null`.
 */
export function highlightLanguage(
  path: string,
  content: string,
): string | null {
  if ((content?.length ?? 0) > HIGHLIGHT_MAX_CHARS) return null;
  return codeLanguage(path);
}
