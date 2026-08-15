import { extOf } from "./fileDecisions";

/**
 * Как файл выглядит в дереве воркспейса.
 *
 * До этого все файлы рисовались одним серым значком: `package.json`,
 * скриншот и `index.tsx` были неотличимы, и дерево читалось только
 * построчно. Различать тип по цвету — то же, что делает редактор кода: глаз
 * находит нужную строку раньше, чем успевает прочитать имя.
 *
 * Здесь только чистое решение «расширение → семейство». Ни разметки, ни
 * React: цвет и значок подставляет `WorkspaceTree`, а проверяется это
 * таблицей входов и выходов.
 */

/**
 * Семейство файла. Список короткий намеренно: это не каталог языков, а набор
 * различий, которые стоит видеть в дереве. Двадцать оттенков мешают ровно так
 * же, как один.
 */
export type FileFamily =
  | "config" /* json, yaml, toml, env — то, что настраивает */
  | "script" /* js, mjs, cjs — исполняемое */
  | "typed" /* ts, tsx — типизированное */
  | "markup" /* html, xml, svg-как-разметка */
  | "style" /* css, scss, less */
  | "doc" /* md, txt, rst */
  | "image" /* png, jpg, webp, gif */
  | "archive" /* zip, tar, gz */
  | "shell" /* sh, bash, Dockerfile, Makefile */
  | "data" /* csv, sql, db */
  | "plain"; /* всё остальное */

/** Значок: обычный лист, картинка или коробка. Больше форм не нужно. */
export type FileGlyph = "file" | "image" | "archive";

export interface FileVisual {
  family: FileFamily;
  glyph: FileGlyph;
  /** CSS-переменная темы или готовый цвет для значка. */
  color: string;
}

/**
 * Цвета семейств.
 *
 * Взяты из палитры проекта, а не из палитры редактора кода: жёлтый конфигов —
 * это `--color-warning`, синий типов — `--color-info`. Так дерево остаётся в
 * той же теме, что и всё остальное, и переключение светлой/тёмной работает
 * само.
 *
 * Оттенков здесь три, а не пять. Зелёный ушёл вместе с ним из всей палитры,
 * и `shell` с `image` встали в обычный тон текста. Потеря невелика:
 * у картинок и архивов свой значок, и различает их он, а не цвет — цвет
 * здесь только у того, что отличается по сути, а не по расширению.
 *
 * `plain` намеренно приглушён: файл без узнаваемого типа не должен
 * притягивать взгляд наравне с остальными.
 */
const FAMILY_COLOR: Record<FileFamily, string> = {
  config: "var(--color-warning)",
  script: "var(--color-warning)",
  typed: "var(--color-info)",
  markup: "var(--color-destructive)",
  style: "var(--color-info)",
  doc: "var(--color-foreground)",
  image: "var(--color-foreground)",
  archive: "var(--color-warning)",
  shell: "var(--color-foreground)",
  data: "var(--color-info)",
  plain: "var(--color-muted-foreground)",
};

/** Расширение → семейство. */
const BY_EXT: Record<string, FileFamily> = {
  json: "config",
  jsonc: "config",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  env: "config",
  conf: "config",

  js: "script",
  mjs: "script",
  cjs: "script",
  jsx: "script",

  ts: "typed",
  tsx: "typed",
  mts: "typed",
  cts: "typed",

  html: "markup",
  htm: "markup",
  xml: "markup",
  vue: "markup",

  css: "style",
  scss: "style",
  sass: "style",
  less: "style",

  md: "doc",
  markdown: "doc",
  txt: "doc",
  rst: "doc",
  pdf: "doc",

  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  ico: "image",
  bmp: "image",
  svg: "image",

  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  rar: "archive",
  "7z": "archive",

  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",

  csv: "data",
  tsv: "data",
  sql: "data",
  db: "data",
  sqlite: "data",
};

/**
 * Файлы без расширения, которые всё равно узнаваемы.
 *
 * Сравнение по полному имени в нижнем регистре: `Dockerfile` и `dockerfile`
 * — один и тот же файл для человека, и дерево не должно их различать.
 */
const BY_NAME: Record<string, FileFamily> = {
  dockerfile: "shell",
  makefile: "shell",
  procfile: "shell",
  ".gitignore": "config",
  ".dockerignore": "config",
  ".env": "config",
  ".npmrc": "config",
  ".editorconfig": "config",
  license: "doc",
  readme: "doc",
};

/** Семейства, которым положен свой значок вместо листа. */
const GLYPH: Partial<Record<FileFamily, FileGlyph>> = {
  image: "image",
  archive: "archive",
};

/**
 * Как рисовать файл в дереве.
 *
 * @param name имя файла (не путь) — то, что видно в строке дерева
 */
export function fileVisual(name: string): FileVisual {
  const clean = (name || "").trim();
  const lower = clean.toLowerCase();

  // Полное имя проверяется ПЕРЕД расширением: у `.gitignore` расширение
  // формально «gitignore», и без этой ветки он попал бы в `plain`.
  const byName = BY_NAME[lower];
  const family: FileFamily =
    byName ?? BY_EXT[extOf(clean).toLowerCase()] ?? "plain";

  return {
    family,
    glyph: GLYPH[family] ?? "file",
    color: FAMILY_COLOR[family],
  };
}
