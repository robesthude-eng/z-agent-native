// Параллельное выполнение независимых инструментов одного шага модели.
// Раньше все вызовы шли строго по очереди: три `read` + `grep` ждали друг друга.
// Параллелим только чистые чтения (и read-only подагентов); всё, что меняет состояние
// (write/edit/bash/git/…), по-прежнему идёт одно за другим и в исходном порядке, а
// результаты всегда обрабатываются в порядке вызовов модели.
import { subagentWrites } from '../subagents.mjs';

export const PARALLEL_LIMIT = 4;
const READ_ONLY_TOOLS = new Set(['read', 'list', 'glob', 'grep', 'repo_map', 'webfetch', 'websearch', 'environment_status']);

export function isParallelSafe(call) {
  const name = String(call?.name || '').toLowerCase();
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (name === 'task') return !subagentWrites(call?.arguments?.agent);
  return false;
}

/** Делит вызовы на последовательные группы: подряд идущие безопасные — пачками ≤ limit, остальные — по одному. */
export function planBatches(calls, limit = PARALLEL_LIMIT) {
  const batches = [];
  let open = null;
  for (const call of calls) {
    if (isParallelSafe(call)) {
      if (open && open.length < limit) open.push(call);
      else {
        open = [call];
        batches.push(open);
      }
    } else {
      open = null;
      batches.push([call]);
    }
  }
  return batches;
}

/**
 * Запускает `run(call, index)` для всех вызовов пачки одновременно и возвращает результаты по порядку.
 * Если что-то бросило исключение, ждёт остальных и пробрасывает первое (отмену — приоритетно).
 */
export async function runBatch(batch, run) {
  if (batch.length === 1) return [await run(batch[0], 0)];
  const settled = await Promise.allSettled(batch.map((call, index) => run(call, index)));
  const failures = settled.filter((s) => s.status === 'rejected');
  if (failures.length) throw (failures.find((f) => f.reason?.name === 'AbortError') || failures[0]).reason;
  return settled.map((s) => s.value);
}
