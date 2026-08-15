import { log } from "../lib/log";
/**
 * Deterministic source-aware message reconciliation helpers.
 * The live SSE transport is implemented by EventStream in events.ts.
 */

/**
 * Pure deterministic merge: source-aware, never shortens streaming text unless server says final.
 *
 * Rules:
 * 1. Server message list is authoritative for IDs that exist on server.
 * 2. Local optimistic messages (id startsWith local_) are preserved until server confirms with same role/text? Actually replaced by server when server message with same local correlation arrives.
 * 3. For assistant messages, if local streaming part text is longer than server text AND server part is not final (no time.completed and finish !== stop|error), keep local longer text.
 * 4. For user messages, preserve local attachment parts that server hasn't echoed yet.
 * 5. Never use JSON.stringify length — use actual text length and part-level comparison.
 */
import { isLocalMessage } from "../lib/ids";
import type { Message as MergeMessage } from "./types";

// export interface MergeMessage {
//   id: string;
//   role: "user" | "assistant" | "system";
//   parts: { id?: string; type: string; text?: string; [k: string]: unknown }[];
//   info?: { finish?: string; time?: { completed?: number } };
// }

// Tool part lifecycle rank — higher means further along. Used to avoid
// downgrading a tool card that SSE already marked completed back to a
// stale "running"/"pending" state from an HTTP snapshot.
const TOOL_STATUS_RANK: Record<string, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  error: 2,
};

function toolStatus(p: unknown): string | undefined {
  const state = (p as { state?: { status?: string } | string }).state;
  if (typeof state === "string") return state;
  return state?.status;
}

/**
 * Collect the trimmed contents of a message's text parts.
 * Used to correlate a server-confirmed user message with its local
 * optimistic counterpart by explicit content instead of array position.
 */
export function userMessageTexts(msg: MergeMessage): Set<string> {
  const texts = new Set<string>();
  for (const p of msg.parts ?? []) {
    const text = (p as { text?: unknown }).text;
    if (p.type === "text" && typeof text === "string" && text.trim()) {
      texts.add(text.trim());
    }
  }
  return texts;
}

/**
 * Deterministic correlation between a server user message and a local
 * optimistic (`local_`) user message.
 *
 * Fixes the "first local_ found" mis-correlation (attachments sticking to
 * the wrong message when several sends are in flight):
 * 1. An exact text-part match wins; the oldest matching optimistic message
 *    is chosen (the server confirms prompts in send order).
 * 2. Without a text match, a single pending optimistic message is
 *    unambiguous and is used as fallback — unless `textMatchOnly` is set
 *    (callers that are not sure the server message is a user echo).
 * 3. Otherwise returns -1 — never hijack an arbitrary optimistic message.
 */
export function findLocalUserMessageIndex(
  messages: MergeMessage[],
  serverMsg: MergeMessage,
  opts?: { textMatchOnly?: boolean },
): number {
  const serverTexts = userMessageTexts(serverMsg);
  let onlyPendingIdx = -1;
  let pendingCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "user" || !isLocalMessage(m.id)) continue;
    pendingCount++;
    if (pendingCount === 1) onlyPendingIdx = i;
    for (const text of userMessageTexts(m)) {
      if (serverTexts.has(text)) return i;
    }
  }
  if (!opts?.textMatchOnly && pendingCount === 1) return onlyPendingIdx;
  return -1;
}

// Релиз 4: dev-инварианты после merge. Сломанное состояние (дубликаты ID,
// сообщения без parts, битые ссылки на вложения) детектится сразу
// в dev-режиме и в тестах, а не через неделю на проде. В проде — no-op.
const IS_DEV = Boolean(import.meta.env?.DEV);

function assertMergeInvariants(messages: MergeMessage[]): void {
  if (!IS_DEV) return;
  const seenIds = new Set<string>();
  for (const m of messages) {
    if (!m || typeof m.id !== "string" || !m.id) {
      log.error("[merge-invariant] сообщение без id:", m);
      continue;
    }
    if (seenIds.has(m.id)) {
      log.error("[merge-invariant] дубликат id сообщения:", m.id);
    }
    seenIds.add(m.id);
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
      log.error("[merge-invariant] невалидная роль:", m.id, m.role);
    }
    if (!Array.isArray(m.parts)) {
      log.error("[merge-invariant] сообщение без parts:", m.id);
      continue;
    }
    const partIds = new Set<string>();
    for (const p of m.parts) {
      const pid = (p as { id?: string }).id;
      if (pid) {
        if (partIds.has(pid)) {
          log.error("[merge-invariant] дубликат id части:", m.id, pid);
        }
        partIds.add(pid);
      }
      if (p.type === "attachment") {
        const att = p as { path?: string; dataUrl?: string; name?: string };
        if (!att.path && !att.dataUrl) {
          log.error(
            "[merge-invariant] вложение без path/dataUrl:",
            m.id,
            att.name,
          );
        }
      }
    }
  }
}

export function mergeMessages(
  serverMsgs: MergeMessage[],
  localMsgs: MergeMessage[],
): MergeMessage[] {
  const merged: MergeMessage[] = [];
  const localById = new Map(localMsgs.map((m) => [m.id, m]));

  for (const sMsg of serverMsgs) {
    const lMsg = localById.get(sMsg.id);
    if (!lMsg) {
      // No local counterpart — take server as-is, but preserve any local attachments if user message
      if (sMsg.role === "user") {
        // Explicit content-based correlation instead of "first local_ found".
        const localOptimisticIdx = findLocalUserMessageIndex(localMsgs, sMsg);
        const localOptimistic =
          localOptimisticIdx === -1 ? undefined : localMsgs[localOptimisticIdx];
        if (localOptimistic) {
          localById.delete(localOptimistic.id);
          const localAtts = localOptimistic.parts.filter(
            (p) => p.type === "attachment",
          );
          if (localAtts.length > 0) {
            const hasAtts = sMsg.parts.some((p) => p.type === "attachment");
            if (!hasAtts) {
              merged.push({ ...sMsg, parts: [...localAtts, ...sMsg.parts] });
              continue;
            }
          }
        }
      }
      merged.push(sMsg);
      continue;
    }

    // Both exist — deterministic merge
    if (sMsg.role === "user") {
      // Preserve local attachments that server hasn't echoed
      const localAtts = lMsg.parts.filter((p) => p.type === "attachment");
      const serverHasAtts = sMsg.parts.some((p) => p.type === "attachment");
      const mergedParts = serverHasAtts
        ? sMsg.parts
        : [...localAtts, ...sMsg.parts.filter((p) => p.type !== "attachment")];
      merged.push({ ...sMsg, parts: mergedParts });
      localById.delete(lMsg.id);
      continue;
    }

    // Assistant message — check for streaming text preservation
    const isFinal = !!(
      sMsg.info?.finish === "stop" ||
      sMsg.info?.finish === "error" ||
      sMsg.info?.time?.completed
    );
    // Релиз 4: Map вместо вложенного .find — убирает квадратичную сложность
    // на длинных ответах. Как и .find, при дубликатах id берём первую часть.
    const lPartsById = new Map<
      string | undefined,
      MergeMessage["parts"][number]
    >();
    for (const p of lMsg.parts) {
      if (!lPartsById.has(p.id)) lPartsById.set(p.id, p);
    }
    const mergedParts = sMsg.parts.map((sPart) => {
      const lPart = lPartsById.get(sPart.id);
      if (!lPart) return sPart;
      // Streaming text preservation applies to text AND reasoning parts:
      // the HTTP poller snapshot may lag behind SSE deltas, so never roll
      // streamed text back while the message is not final.
      if (
        (sPart.type === "text" || sPart.type === "reasoning") &&
        lPart.type === sPart.type
      ) {
        const sText = (sPart as { text?: string }).text || "";
        const lText = (lPart as { text?: string }).text || "";
        // If server is NOT final and local text is longer and is prefix-extended from server, keep local
        // Example: server "first", local "first second" — keep local because server hasn't finished streaming
        // But if server text is different (not prefix), take server (authoritative)
        if (
          !isFinal &&
          lText.length > sText.length &&
          lText.startsWith(sText)
        ) {
          return { ...sPart, text: lText };
        }
        // Deterministic: server wins when final, local wins when non-final and longer
        return sPart;
      }
      // Tool parts: never downgrade a local state that is further along
      // (completed/error via SSE) to an older server snapshot (pending/running).
      if (sPart.type === "tool" && lPart.type === "tool" && !isFinal) {
        const sRank = TOOL_STATUS_RANK[toolStatus(sPart) ?? ""] ?? -1;
        const lRank = TOOL_STATUS_RANK[toolStatus(lPart) ?? ""] ?? -1;
        if (lRank > sRank) return lPart;
      }
      return sPart;
    });

    // Also preserve any local parts that server hasn't yet sent (e.g., part_late that arrived out-of-order via delta)
    // Релиз 4: Set вместо вложенного .find.
    const mergedPartIds = new Set(mergedParts.map((p) => p.id));
    for (const lPart of lMsg.parts) {
      if (!mergedPartIds.has(lPart.id)) {
        mergedParts.push(lPart);
        mergedPartIds.add(lPart.id);
      }
    }

    merged.push({ ...sMsg, parts: mergedParts });
    localById.delete(lMsg.id);
  }

  // Add remaining local messages that server doesn't know (optimistic, not local_? Already handled local_ skip)
  // Keep non-local_ local messages that are not yet on server (e.g., pending user message)
  // Релиз 4: Set идентификаторов вместо merged.find на каждой итерации.
  const mergedIds = new Set(merged.map((m) => m.id));
  for (const [id, lMsg] of localById) {
    if (isLocalMessage(id)) continue; // optimistic already handled or replaced
    if (!mergedIds.has(id)) {
      merged.push(lMsg);
      mergedIds.add(id);
    }
  }

  // Preserve original server order, but ensure optimistic local_ messages that weren't replaced stay at end
  // Actually we already filtered local_ during loop; re-add any remaining local_ if they weren't replaced
  for (const lMsg of localMsgs) {
    if (isLocalMessage(lMsg.id) && !mergedIds.has(lMsg.id)) {
      // If server has a user message that corresponds to this local_ (by exact text content across any user message), don't duplicate
      const localTexts = userMessageTexts(lMsg);
      let alreadyConfirmed = false;
      for (const m of merged) {
        if (m.role === "user" && !isLocalMessage(m.id)) {
          for (const t of userMessageTexts(m)) {
            if (localTexts.has(t)) {
              alreadyConfirmed = true;
              break;
            }
          }
        }
        if (alreadyConfirmed) break;
      }
      if (alreadyConfirmed) continue;
      merged.push(lMsg);
      mergedIds.add(lMsg.id);
    }
  }

  // Релиз 4: проверка инвариантов результата (только dev/тесты).
  assertMergeInvariants(merged);

  return merged;
}

/**
 * Deterministic scenario harness for tests (fake timers compatible)
 * Allows simulating event sequences and asserting final merged state.
 */
export function createScenarioHarness(
  initialLocal: MergeMessage[] = [],
  initialServer: MergeMessage[] = [],
) {
  let local = [...initialLocal];
  let server = [...initialServer];

  return {
    setLocal(msgs: MergeMessage[]) {
      local = [...msgs];
    },
    setServer(msgs: MergeMessage[]) {
      server = [...msgs];
    },
    applyServerUpdate(newServer: MergeMessage[]) {
      server = [...newServer];
      return mergeMessages(server, local);
    },
    applyLocalDelta(
      _sessionId: string,
      messageId: string,
      partId: string,
      delta: string,
    ) {
      // Simulate message.part.delta applied to local
      local = local.map((m) => {
        if (m.id !== messageId) return m;
        return {
          ...m,
          parts: m.parts.map((p) => {
            if (p.id !== partId) return p;
            return { ...p, text: (p.type === "text" ? p.text : "") + delta };
          }),
        };
      });
      return [...local];
    },
    getMerged() {
      return mergeMessages(server, local);
    },
    getLocal() {
      return [...local];
    },
    getServer() {
      return [...server];
    },
  };
}
