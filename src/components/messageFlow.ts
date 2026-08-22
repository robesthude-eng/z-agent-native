import { isVisible, presentationFor } from "../api/partPresentation";
import type { Message, Part, ToolPart } from "../api/types";

/**
 * Как лента собирает ответ агента: что склеить в цепочку, что показать
 * отдельно и сколько шагов написать в её шапке.
 *
 * Вынесено из `MessageItem.tsx` не ради чистоты, а потому что здесь дважды
 * ошиблись молча, и обе ошибки видно только глазами на живом чате:
 *
 * 1. В шапке стояло «2 шага», а внутри была одна строка. Считались ВСЕ
 *    элементы цепочки, включая служебные `step-start` и `step-finish`,
 *    которые ничего не рисуют. Число и содержимое расходились тем сильнее,
 *    чем длиннее ход.
 * 2. Подряд идущие действия разбивались на отдельные «Действия» без текста
 *    между ними. Цепочка строилась ВНУТРИ каждого сообщения, а движок
 *    присылает ход несколькими сообщениями подряд — на каждой границе
 *    цепочка обрывалась.
 *
 * Обе теперь проверяются перебором входов, а не взглядом на телефон.
 */

export interface ToolGroupData {
  kind: "group";
  tool: string;
  parts: ToolPart[];
}
export type RenderItem = Part | ToolGroupData;

/**
 * Идентичность части сообщения. Части с сервера несут id (prt_…), локальные
 * оптимистичные сообщения собираются в messagesSlice без него — там опознаём
 * вложение по имени/пути.
 */
export function partKey(part: Part): string {
  const p = part as {
    id?: unknown;
    callID?: unknown;
    name?: unknown;
    filename?: unknown;
    path?: unknown;
    url?: unknown;
    type?: unknown;
  };
  const pick = (v: unknown) => (typeof v === "string" ? v : "");
  return (
    pick(p.id) ||
    pick(p.callID) ||
    pick(p.name) ||
    pick(p.filename) ||
    pick(p.path) ||
    pick(p.url) ||
    pick(p.type) ||
    "part"
  );
}

/**
 * Ключ элемента ленты. Индекс тут не годится: groupParts склеивает подряд
 * идущие вызовы одного инструмента, поэтому при приходе второго вызова список
 * укорачивается и всё после сдвигается — по индексу React перенёс бы состояние
 * карточки (раскрыта/свёрнута) на чужой элемент.
 */
export function itemKey(item: RenderItem): string {
  const g = item as ToolGroupData;
  if ("kind" in g && g.kind === "group") {
    const first = g.parts[0];
    return `group:${g.tool}:${first ? partKey(first) : ""}`;
  }
  return partKey(item as Part);
}

export function toolName(p: { tool?: unknown }): string | undefined {
  // Defensive: a streaming source can send `tool` as {messageID, callID} object reference
  // during streaming. Treat non-strings as "unknown tool" so grouping/rendering
  // never sees an object (prevents React error #31).
  return typeof p.tool === "string" && p.tool ? p.tool : undefined;
}

export function groupParts(parts: Part[]): RenderItem[] {
  const result: RenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const cur = parts[i];
    if (!cur) break; // noUncheckedIndexedAccess: за пределами массива
    const part = cur as { type?: string; tool?: unknown };
    const name = toolName(part);
    if (part.type === "tool" && name) {
      const group: ToolPart[] = [parts[i] as ToolPart];
      // Reasoning-части («Думал…») между одинаковыми действиями не разрывают
      // группу: собираем их отдельно и рендерим после группы.
      const skippedReasoning: Part[] = [];
      let j = i + 1;
      while (j < parts.length) {
        const next = parts[j] as { type?: string; tool?: unknown };
        if (next.type === "tool" && toolName(next) === name) {
          group.push(parts[j] as ToolPart);
          j++;
        } else if (next.type === "reasoning") {
          // Заглядываем вперёд через подряд идущие reasoning-части:
          // если за ними то же действие — группа продолжается.
          let k = j;
          while (
            k < parts.length &&
            (parts[k] as { type?: string }).type === "reasoning"
          ) {
            k++;
          }
          const after = parts[k] as
            | { type?: string; tool?: unknown }
            | undefined;
          if (after && after.type === "tool" && toolName(after) === name) {
            for (let m = j; m < k; m++) {
              const rp = parts[m];
              if (rp) skippedReasoning.push(rp);
            }
            j = k;
          } else break;
        } else break;
      }
      if (group.length > 1) {
        result.push({ kind: "group", tool: name, parts: group });
      } else {
        result.push(cur);
      }
      for (const r of skippedReasoning) result.push(r);
      i = j;
    } else {
      result.push(cur);
      i++;
    }
  }
  return result;
}

/**
 * Части-«действия»: то, что сворачивается в цепочку AgentActivity.
 * Текст (комментарии между действиями и финальный отчёт) и вложения —
 * видимый контент, в цепочки не попадают.
 */
export function isActivityItem(item: RenderItem): boolean {
  if (!("type" in item)) return true; // ToolGroupData — группа вызовов инструмента
  return (
    item.type === "tool" ||
    item.type === "step-start" ||
    item.type === "step-finish" ||
    item.type === "step-reasoning"
  );
}

export interface ActivityRun {
  kind: "activity";
  items: RenderItem[];
}
export type FlowItem = RenderItem | ActivityRun;

/**
 * Схлопывает подряд идущие «действия» (от двух и больше) в один
 * сворачиваемый блок. Одиночное действие остаётся как есть — оно и так
 * компактная ghost-строка, лишняя обёртка только добавила бы шума.
 */
export function groupActivityRuns(items: RenderItem[]): FlowItem[] {
  const out: FlowItem[] = [];
  let run: RenderItem[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "activity", items: run });
    else out.push(...run);
    run = [];
  };
  for (const item of items) {
    // Часть, которая ничего не рисует, цепочку не разрывает.
    //
    // Именно из-за этого действия шли подряд отдельными «Действиями» без
    // единого слова между ними: движок вставляет между ними текстовые части
    // с пустым текстом и служебные границы хода. На экране их нет, а
    // группировка спотыкалась о каждую.
    //
    // Видимость берётся из `presentationFor`, а не решается здесь заново:
    // ровно по нему `PartView` и решает, рисовать ли часть. Разъедься эти
    // два места — цепочка снова начала бы рваться о невидимое.
    if ("type" in item && !isVisible(presentationFor(item))) continue;
    if (isActivityItem(item)) run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/** Статус вызова инструмента: строка или объект `{status}` — как в ToolGroup. */
export function toolStatus(part: ToolPart): string {
  const s = part.state;
  if (typeof s === "string") return s;
  if (s && typeof s === "object")
    return (s as { status?: string }).status ?? "";
  return "";
}

/** Все вызовы инструментов внутри цепочки (группы разворачиваются). */
export function runToolParts(items: RenderItem[]): ToolPart[] {
  const tools: ToolPart[] = [];
  for (const it of items) {
    const g = it as ToolGroupData;
    if ("kind" in g && g.kind === "group") tools.push(...g.parts);
    else if ((it as Part).type === "tool") tools.push(it as ToolPart);
  }
  return tools;
}

/**
 * Части, которые попадают в цепочку, но ничего не рисуют.
 *
 * Движок размечает ими границы хода. В ленте у них нет ни строки, ни
 * значка — поэтому в счёте шагов им не место: пользователь читает «2 шага»
 * и разворачивает, а внутри одна строка.
 */
const INVISIBLE_STEPS = new Set(["step-start", "step-finish"]);

/**
 * «Шаги» цепочки для шапки.
 *
 * Считается ровно то, что человек увидит, развернув её: вызовы
 * инструментов и размышления. Служебные границы хода пропускаются — они не
 * шаг, а разделитель.
 *
 * Раньше здесь стоял `reduce` по всем элементам, и число в шапке было
 * больше содержимого на количество этих границ.
 */
export function runStepCount(items: RenderItem[]): number {
  return items.reduce((n, it) => {
    const g = it as ToolGroupData;
    if ("kind" in g && g.kind === "group") return n + g.parts.length;
    // `type` в частях с сервера объявлен нестрого: приходит и не строка.
    const type = (it as { type?: unknown }).type;
    const invisible = typeof type === "string" && INVISIBLE_STEPS.has(type);
    return invisible ? n : n + 1;
  }, 0);
}

/**
 * Части всех сообщений хода подряд, одним списком.
 *
 * Движок присылает ход несколькими сообщениями: текст, потом инструменты,
 * потом снова текст. Пока цепочка строилась внутри каждого сообщения,
 * на каждой границе она обрывалась — в ленте шли подряд «Действия · 2
 * шага», «Действия · 3 шага», «Действия · 3 шага», хотя между ними не было
 * ни слова текста. Для читателя это один заход агента, и цепочка должна
 * быть одна.
 *
 * Склейка идёт до группировки: границы сообщений для ленты не значат
 * ничего, значат только смены рода частей.
 */
function textContent(part: Part): string {
  return part.type === "text" ? String((part as { text?: string }).text || "") : "";
}

const REPEAT_PREFIX_MIN = 12;

/** Один абзац, повторённый через пустую строку внутри той же части. */
function collapseDoubledParagraph(part: Part): Part {
  const raw = textContent(part);
  const blocks = raw
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const first = blocks[0];
  const second = blocks[1];
  if (blocks.length === 2 && first && second && first === second && first.length >= REPEAT_PREFIX_MIN) {
    const cut = raw.indexOf(second, first.length);
    return {
      ...part,
      text: (cut > 0 ? raw.slice(0, cut) : first).trimEnd(),
    } as Part;
  }
  return part;
}

/**
 * Повтор абзаца в ленте: мобильный SSE-reconnect без Last-Event-ID
 * проигрывает те же текстовые кадры ещё раз. Инструменты — снимки, они
 * не двоятся. Либо две одинаковые text-части подряд, либо одна часть
 * «абзац\\n\\nабзац», либо усечённый стрим и следом полный тот же абзац.
 */
export function collapseRepeatedTextParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      out.push(part);
      continue;
    }
    const collapsed = collapseDoubledParagraph(part);
    const trimmed = textContent(collapsed).trim();
    const prev = out[out.length - 1];
    if (prev?.type === "text") {
      const prevTrim = textContent(prev).trim();
      if (trimmed && prevTrim === trimmed) continue;
      if (prevTrim.length >= REPEAT_PREFIX_MIN && trimmed.length >= REPEAT_PREFIX_MIN) {
        if (trimmed.startsWith(prevTrim)) {
          out[out.length - 1] = collapsed;
          continue;
        }
        if (prevTrim.startsWith(trimmed)) continue;
      }
    }
    out.push(collapsed);
  }
  return out;
}

export function flowParts(messages: Message[]): Part[] {
  const out: Part[] = [];
  for (const m of messages) {
    for (const p of m.parts || []) out.push(p);
  }
  return collapseRepeatedTextParts(out);
}
