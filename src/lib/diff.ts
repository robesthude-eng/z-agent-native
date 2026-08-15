/**
 * Построчный diff для показа изменений агента и несохранённых правок.
 *
 * Зачем свой, а не библиотека: правку нужно показывать в чате на каждой карточке
 * инструмента `edit`, то есть десятки раз в длинном диалоге и во время стрима.
 * Тянуть ради этого зависимость в бандл (он и так 1.4 МБ) незачем — задача
 * решается сотней строк.
 *
 * Алгоритм: срезаем совпадающие начало и конец, затем LCS по строкам на
 * остатке. Реальная правка меняет несколько строк в середине файла, поэтому
 * после срезки LCS почти всегда работает на десятках строк, а не на всём файле.
 * Если середина всё равно огромная, честно помечаем результат `truncated` и
 * показываем её как «удалено целиком / добавлено целиком» — это лучше, чем
 * заморозить вкладку на квадратичной матрице.
 */

export type DiffOp = "ctx" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** Номер строки в исходной версии (1-based), null для добавленных. */
  oldNo: number | null;
  /** Номер строки в новой версии (1-based), null для удалённых. */
  newNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Середина оказалась слишком большой для LCS — показана блоком. */
  truncated: boolean;
}

export interface DiffOptions {
  /** Сколько неизменённых строк показывать вокруг правки. */
  context?: number;
  /**
   * Максимальный размер «середины» для LCS. 1200×1200 — это ~1.4 млн ячеек,
   * что считается за единицы миллисекунд; выше — уже заметно на глаз.
   */
  maxLcsLines?: number;
}

function splitLines(text: string): string[] {
  // Завершающий перевод строки не должен превращаться в пустую строку-призрак,
  // иначе любой файл выглядит изменённым в последней строке.
  const normalized = text.replace(/\r\n/g, "\n");
  // Пустой файл — ноль строк, а не одна пустая: иначе создание файла выглядит
  // как «удалена строка + добавлены строки».
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Индексы LCS: для каждой пары (i,j) — длина наибольшей общей подпоследовательности. */
function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // (n+1)×(m+1) в одном плоском массиве — меньше давления на GC.
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        a[i] === b[j]
          ? (table[at(i + 1, j + 1)] ?? 0) + 1
          : Math.max(table[at(i + 1, j)] ?? 0, table[at(i, j + 1)] ?? 0);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("ctx");
      i++;
      j++;
    } else if ((table[at(i + 1, j)] ?? 0) >= (table[at(i, j + 1)] ?? 0)) {
      ops.push("del");
      i++;
    } else {
      ops.push("add");
      j++;
    }
  }
  while (i < n) {
    ops.push("del");
    i++;
  }
  while (j < m) {
    ops.push("add");
    j++;
  }
  return ops;
}

/**
 * Полный список строк с пометками. Экспортируется для тестов и для случаев,
 * когда нужен весь файл, а не только изменённые участки.
 */
function diffLineList(
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): { lines: DiffLine[]; truncated: boolean } {
  const maxLcs = options.maxLcsLines ?? 1200;
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  let ops: DiffOp[];
  let truncated = false;
  if (midA.length > maxLcs || midB.length > maxLcs) {
    truncated = true;
    ops = [...midA.map((): DiffOp => "del"), ...midB.map((): DiffOp => "add")];
  } else {
    ops = lcsOps(midA, midB);
  }

  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let k = 0; k < prefix; k++) {
    lines.push({ op: "ctx", text: a[k] ?? "", oldNo: oldNo++, newNo: newNo++ });
  }
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === "ctx") {
      lines.push({
        op,
        text: midA[ai] ?? "",
        oldNo: oldNo++,
        newNo: newNo++,
      });
      ai++;
      bi++;
    } else if (op === "del") {
      lines.push({ op, text: midA[ai] ?? "", oldNo: oldNo++, newNo: null });
      ai++;
    } else {
      lines.push({ op, text: midB[bi] ?? "", oldNo: null, newNo: newNo++ });
      bi++;
    }
  }
  for (let k = a.length - suffix; k < a.length; k++) {
    lines.push({ op: "ctx", text: a[k] ?? "", oldNo: oldNo++, newNo: newNo++ });
  }

  return { lines, truncated };
}

/**
 * Diff, сгруппированный в участки с контекстом — то, что показывается в UI.
 * Для идентичных текстов возвращает пустой список участков: вызывающий по нему
 * и понимает, что показывать нечего.
 */
export function diffLines(
  oldText: string,
  newText: string,
  options: DiffOptions = {},
): DiffResult {
  const context = options.context ?? 3;
  const { lines, truncated } = diffLineList(oldText, newText, options);

  const added = lines.filter((l) => l.op === "add").length;
  const removed = lines.filter((l) => l.op === "del").length;
  if (added === 0 && removed === 0) {
    return { hunks: [], added: 0, removed: 0, truncated };
  }

  // Строка попадает в вывод, если она изменена или стоит рядом с изменением.
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.op === "ctx") return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  });

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  lines.forEach((line, index) => {
    if (!keep[index]) {
      current = null;
      return;
    }
    if (!current) {
      current = {
        oldStart: line.oldNo ?? 0,
        newStart: line.newNo ?? 0,
        lines: [],
      };
      hunks.push(current);
    }
    current.lines.push(line);
  });

  return { hunks, added, removed, truncated };
}

/** Подпись вида «+12 −3» для заголовков карточек. */
export function diffStatLabel(result: {
  added: number;
  removed: number;
}): string {
  return `+${result.added} −${result.removed}`;
}
