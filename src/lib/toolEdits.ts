/**
 * Извлечение «что именно инструмент сделал с файлом» из аргументов вызова.
 *
 * Живёт отдельно от карточки инструмента, потому что имена полей зависят от
 * формата события и от самого инструмента (`edit` отдаёт одну пару строк,
 * `multiedit` — список, часть версий использует snake_case). Это правило
 * разбора, а не разметка, и его нужно проверять тестами.
 */

import { isRecord } from "../api/eventGuards";
import { toWorkspaceRelPath } from "./workspacePath";

export interface ToolEdit {
  oldText: string;
  newText: string;
}

function readEdit(value: unknown): ToolEdit | null {
  if (!isRecord(value)) return null;
  const oldText = value.oldString ?? value.old_string;
  const newText = value.newString ?? value.new_string;
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  return { oldText, newText };
}

/** Правки инструмента: одиночная (`edit`) или список (`multiedit`). */
export function extractToolEdits(input: unknown): ToolEdit[] {
  if (!isRecord(input)) return [];
  const single = readEdit(input);
  if (single) return [single];
  const list = input.edits;
  if (Array.isArray(list)) {
    return list.map(readEdit).filter((e): e is ToolEdit => e !== null);
  }
  return [];
}

/** Путь файла, с которым работал инструмент, относительно корня воркспейса. */
export function extractToolFilePath(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of ["filePath", "file_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value) {
      const rel = toWorkspaceRelPath(value);
      if (rel) return rel;
    }
  }
  return null;
}

/**
 * Содержимое, которое инструмент ПИШЕТ в файл.
 *
 * Отдельно от `extractToolEdits`: там правка — пара «было/стало», а здесь
 * файл создаётся целиком, и показывать надо сам текст, а не аргументы.
 *
 * До этого карточка `write` показывала JSON вызова целиком: путь, содержимое
 * и служебные поля одной простынёй с экранированными переводами строк. Файл
 * в ней прочитать было нельзя — ни пока он пишется, ни после.
 *
 * Возвращает строку и когда она пустая, и когда неполная: содержимое
 * приезжает дельтами и растёт на глазах, а `null` означает «этот вызов
 * файл не пишет» — только для него уместен плейсхолдер.
 */
export function extractWrittenContent(input: unknown): string | null {
  if (!isRecord(input)) return null;
  // Только поля «текст целиком». `newString` сюда не входит намеренно: это
  // половина пары «было/стало», и показывать её как записанный файл значило
  // бы выдать часть правки за весь файл.
  for (const key of ["content", "contents", "text"]) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return null;
}
