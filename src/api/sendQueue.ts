/**
 * Очередь отправки: решения отдельно от компонента.
 *
 * Этап 2.4. Серверная очередь (`server/action-queue.mjs`, маршрут
 * `/api/session/:id/queue`) существует с Wave 1, но источником правды до сих
 * пор был `useState` внутри `Composer.tsx` — поэтому I-15 держался наполовину:
 * очередь переживала перезапуск сервера и не переживала закрытие вкладки.
 *
 * Согласовано 01.08.2026: внешне ничего не меняется — тот же список над
 * композером, — меняется источник. Следствие, которого не было в вариантах:
 * очередь хранится ПО СЕССИИ, поэтому «источник — сервер» делает её общей для
 * вкладок сам собой. Это не побочный эффект, а то же самое требование I-10,
 * только про очередь.
 *
 * Здесь нет ни React, ни `fetch`: всё, что можно решить, решается функциями и
 * проверяется без браузера. Компонент остаётся разметкой и вызовами сети.
 */

import { newActionId, sessionActionPrep } from "@/lib/ids";

/** Запись очереди в том виде, в каком её рисует композер. */
export interface QueueEntry {
  /** Ключ действия. Тот же, с которым сообщение уйдёт: очередь и реестр
   *  говорят об одном действии, и придумывать второй ключ нельзя. */
  actionId: string;
  text: string;
  /** Позицию присваивает сервер. У локальных записей её нет. */
  position: number | null;
  /** `local` — запись ещё не принята сервером: либо черновик, либо очередь
   *  недоступна. Различие видно в тесте и не видно пользователю. */
  origin: "server" | "local";
}

/** Что делать с сообщением, набранным во время работы агента. */
export type EnqueuePlan =
  | { kind: "server"; sessionId: string; actionId: string; text: string }
  | { kind: "local"; actionId: string; text: string; why: LocalReason };

export type LocalReason = "flag_off" | "draft_session" | "queue_unavailable";

/** Включён ли перевод композера на серверную очередь. */
export function serverQueueEnabled(): boolean {
  try {
    return import.meta.env?.VITE_SERVER_QUEUE === "1";
  } catch {
    return false;
  }
}

/**
 * Куда класть сообщение.
 *
 * Черновик уходит в локальную очередь всегда, и это не упрощение: сессии на
 * сервере ещё нет, а `isValidSessionId` отвергает `tmp_`. Условие «сессия
 * настоящая» намеренно совпадает с серверным — расхождение здесь дало бы 400
 * на каждую постановку в новом чате.
 */
export function enqueuePlan(
  text: string,
  sessionId: string | null,
  opts: { enabled?: boolean; actionId?: string } = {},
): EnqueuePlan {
  const actionId = opts.actionId ?? newActionId();
  const enabled = opts.enabled ?? serverQueueEnabled();
  if (!enabled) return { kind: "local", actionId, text, why: "flag_off" };
  // Правило «сессия настоящая» берётся у `sessionActionPrep`, а не пишется
  // заново: вторая копия того же условия разошлась бы с первой молча, и
  // разошлась бы именно на `tmp_` — то есть в новом чате.
  if (sessionId === null || sessionActionPrep(sessionId) !== "ready") {
    return { kind: "local", actionId, text, why: "draft_session" };
  }
  return { kind: "server", sessionId, actionId, text };
}

/**
 * Отказ сервера НЕ теряет сообщение.
 *
 * Маршрут очереди прямо говорит, что её недоступность — не повод отказать:
 * очередь улучшает работающую отправку, а не заменяет её. Поэтому любой
 * неуспех постановки превращается в локальную запись, а не в ошибку
 * пользователю. Цель метрики «потерянные из очереди сообщения» — ноль, и
 * достигается она здесь, а не сообщением об ошибке.
 */
export function fallbackToLocal(plan: EnqueuePlan): EnqueuePlan {
  if (plan.kind === "local") return plan;
  return {
    kind: "local",
    actionId: plan.actionId,
    text: plan.text,
    why: "queue_unavailable",
  };
}

/**
 * Что показать: серверные записи в порядке позиции, локальные — следом.
 *
 * Локальные идут после намеренно. Позицию присваивает сервер, и у записи без
 * позиции нет способа встать в середину так, чтобы порядок совпал с тем, в
 * каком очередь будет отправлена. Показать её раньше значило бы обещать
 * порядок, которого не будет.
 *
 * Дубликаты по `actionId` схлопываются в пользу серверной записи: пока ответ
 * на постановку идёт, запись живёт локально, и после подтверждения она не
 * должна появиться дважды.
 */
export function mergeQueue(
  server: readonly QueueEntry[],
  local: readonly QueueEntry[],
): QueueEntry[] {
  const onServer = new Set(server.map((e) => e.actionId));
  const ordered = [...server].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  return [...ordered, ...local.filter((e) => !onServer.has(e.actionId))];
}

/**
 * Что уходит следующим, когда агент освободился.
 *
 * Ровно одна запись за раз — то же правило, что и у серверного осушения:
 * отправить всю очередь подряд значило бы завести параллельный ход, ради
 * предотвращения которого очередь и нужна.
 */
export function nextToSend(
  queue: readonly QueueEntry[],
  busy: boolean,
): QueueEntry | null {
  if (busy) return null;
  return queue[0] ?? null;
}

/** Как убирать запись по крестику: серверную — запросом, локальную — из состояния. */
export function removalPlan(
  entry: QueueEntry,
  sessionId: string | null,
):
  | { kind: "server"; sessionId: string; actionId: string }
  | { kind: "local"; actionId: string } {
  if (entry.origin === "server" && sessionActionPrep(sessionId) === "ready") {
    return {
      kind: "server",
      sessionId: sessionId as string,
      actionId: entry.actionId,
    };
  }
  return { kind: "local", actionId: entry.actionId };
}

/**
 * Разбор ответа `GET /api/session/:id/queue`.
 *
 * Мусор в поле не роняет композер и не опустошает очередь молча: неразобранная
 * запись пропускается, разобранные остаются. Пустой ответ и сломанный ответ —
 * разные вещи, и вторая не должна выглядеть как первая.
 */
export function parseServerQueue(body: unknown): QueueEntry[] {
  const rows = (body as { queue?: unknown })?.queue;
  if (!Array.isArray(rows)) return [];
  const out: QueueEntry[] = [];
  for (const row of rows) {
    const r = row as {
      actionId?: unknown;
      payload?: unknown;
      position?: unknown;
    };
    if (typeof r?.actionId !== "string" || !r.actionId) continue;
    const text = (r.payload as { text?: unknown })?.text;
    if (typeof text !== "string") continue;
    out.push({
      actionId: r.actionId,
      text,
      position: typeof r.position === "number" ? r.position : null,
      origin: "server",
    });
  }
  return out;
}
