/**
 * Когда ход действительно закончился.
 *
 * Почему понадобился отдельный модуль. Движок помечает завершённым КАЖДЫЙ шаг
 * ассистента, а не только последний: модель остановилась ровно затем, чтобы
 * движок выполнил инструмент и позвал её снова. Такое промежуточное сообщение
 * получает и `time.completed`, и `finish` — и от настоящего финала оно
 * неотличимо ничем, кроме причины остановки и живого инструмента внутри.
 *
 * Клиент до сих пор закрывал ход по этому маркеру сразу. Последствие видно не
 * в индикаторе, а в очереди композера: `busy` снимался посреди работы агента,
 * очередь считала сессию свободной и отправляла следующее сообщение в
 * работающий ход. Движок на новый промпт прерывает текущий («Ход остановлен») и
 * начинает отвечать заново — со стороны это выглядит как сообщения, которые
 * пользователь не отправлял, и агент, который не может остановиться.
 *
 * Основной источник истины — persisted turn projection из
 * `server/native/agent.mjs`. Эта логика остаётся клиентским fallback для
 * старого режима и для восстановления при недоступном SSE.
 *
 * В файле нет ни React, ни сети: только решения, и их можно проверить тестом.
 */

import { rawToolStatus } from "../lib/toolStatus";
import type { Message } from "./types";

/**
 * Окно стабилизации клиентского fallback после финального маркера. Серверный
 * turn projection не выводит завершение из этого таймера.
 */
export const FINAL_SETTLE_MS = 3_000;

/**
 * Причины остановки, которыми ход НЕ заканчивается.
 *
 * Модель отдала вызов инструмента и ждёт его результата. Написание вариантов
 * через дефис и подчёркивание — не перестраховка: провайдеры отдают
 * `tool-calls` и `tool_calls` вперемешку, а ошибка здесь стоит ровно того
 * самого преждевременного «свободна».
 */
const STEP_FINISH_REASONS = new Set([
  "tool-calls",
  "tool_calls",
  "tool-call",
  "tool_call",
  "toolcalls",
  "tool-use",
  "tool_use",
]);

/** Остановка ради инструмента — то есть шаг, а не финал. */
export function isStepFinish(finish?: unknown): boolean {
  return (
    typeof finish === "string" &&
    STEP_FINISH_REASONS.has(finish.trim().toLowerCase())
  );
}

/**
 * Есть ли в сообщении инструмент, который прямо сейчас работает.
 *
 * Блокирует финал только ЯВНЫЙ `running`/`pending`. Отсутствие статуса финалом
 * не считается специально: часть без состояния приходит и от старых версий
 * движка, и из HTTP-снимка, и трактовать её как работу значило бы не отпускать
 * интерфейс никогда — то есть менять одну поломку на другую.
 */
export function hasRunningTool(msg?: Message | null): boolean {
  for (const p of msg?.parts ?? []) {
    if ((p as { type?: string }).type !== "tool") continue;
    const st = rawToolStatus(p);
    if (st === "running" || st === "pending") return true;
  }
  return false;
}

/**
 * Что говорит о сообщении его собственная разметка.
 *
 * `"none"` — маркера нет; `"step"` — маркер есть, но это шаг (вызов
 * инструмента или инструмент ещё в работе); `"final"` — маркер похож на конец
 * хода. Даже `"final"` остаётся подсказкой: подтверждает её тишина, а не сам
 * маркер.
 */
export function finalMarkerOf(msg?: Message | null): "none" | "step" | "final" {
  if (!msg) return "none";
  const info = msg.info as
    | { finish?: unknown; time?: { completed?: unknown } }
    | undefined;
  const finish = info?.finish ?? (msg as { finish?: unknown }).finish;
  const completed = info?.time?.completed;
  if (!finish && !completed) return "none";
  // Порядок проверок важен: живой инструмент перевешивает любую причину
  // остановки. Движок закрывает сообщение шага РАНЬШЕ, чем инструмент отдаёт
  // результат, и без этой ветки шаг с сорокасекундным bash выглядел бы
  // законченным ходом всё время, пока команда выполняется.
  if (hasRunningTool(msg)) return "step";
  if (isStepFinish(finish)) return "step";
  return "final";
}

/**
 * Финал по истории сообщений (для HTTP-поллера).
 *
 * Смотрит на последнее сообщение ассистента: именно его завершённость и есть
 * ответ на вопрос. Сигнатура нужна поллеру, чтобы отличить «состояние не
 * менялось» от «пришло что-то новое», и в неё входит статус инструментов —
 * иначе растущий вывод команды не сдвигал бы её и тишина считалась бы
 * подтверждённой.
 */
export function assistantFinishState(msgs: Message[]) {
  let lastAsst: Message | undefined;
  for (const m of msgs) if (m?.role === "assistant") lastAsst = m;
  const info = lastAsst?.info as
    | { finish?: unknown; time?: { completed?: unknown } }
    | undefined;
  const finish = typeof info?.finish === "string" ? info.finish : undefined;
  const completedAt =
    typeof info?.time?.completed === "number" ? info.time.completed : undefined;
  const marker = finalMarkerOf(lastAsst);
  const toolSig = (lastAsst?.parts ?? [])
    .filter((p) => (p as { type?: string }).type === "tool")
    .map((p) => rawToolStatus(p) ?? "?")
    .join(",");
  const sig = `${lastAsst?.id || ""}|${completedAt || 0}|${lastAsst?.parts?.length || 0}|${finish || ""}|${toolSig}`;
  return { isDone: marker === "final", sig, completedAt };
}
