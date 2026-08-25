import {
  findLocalUserMessageIndex,
  userMessageTexts,
} from "../api/messageMerge";
import type { Message, Part, TextPart, ToolPart } from "../api/types";
import { isLocalMessage } from "../lib/ids";

export function cleanSysText(t: string): string {
  return typeof t === "string" ? t : t || "";
}

/** Type guard: is this Part a TextPart (has .text string)? */
function isTextPart(p: Part): p is TextPart {
  return p.type === "text" && typeof (p as TextPart).text === "string";
}

/** Type guard: does this Part have an `id` field? */
function hasId(p: Part): p is Part & { id: string } {
  return typeof (p as { id?: unknown }).id === "string";
}

/**
 * Normalize a tool-part's `tool` field.
 *
 * During partial streaming updates, `tool` can temporarily be an object reference
 * `{ messageID, callID }` during streaming instead of the actual tool name
 * string. Rendering that object directly as a React child causes error #31
 * ("Objects are not valid as a React child"). We guard defensively:
 *  - string -> returned as-is
 *  - object/anything else -> undefined (UI falls back to a generic "tool" label)
 */
export function normalizePartTool(p: Part): Part {
  if (p && p.type === "tool") {
    const tp = p as ToolPart;
    const tool = typeof tp.tool === "string" && tp.tool ? tp.tool : undefined;
    if (tool === tp.tool) return p;
    // Не записываем `tool: undefined`: при merge streaming update это затёрло
    // бы уже известное строковое имя инструмента объектом-ссылкой из позднего
    // события. Удалённое поле позволяет patchPart сохранить прежнее имя.
    const { tool: _opaqueToolRef, ...rest } = tp;
    return rest as Part;
  }
  return p;
}

// Normalize a message from the API: ensure `id` and `role` are at the top level.
// Persisted/streamed payloads may carry id/role inside info; normalize defensively.
export function normalizeMessage(msg: Message): Message {
  const info = msg.info;
  const id = msg.id || info?.id || "";
  const role: Message["role"] =
    msg.role || (info?.role as Message["role"] | undefined) || "assistant";
  const rawParts = msg.parts || [];
  const parts = rawParts.map((p) => {
    const np = normalizePartTool(p);
    if (role === "user" && isTextPart(np)) {
      return { ...np, text: cleanSysText(np.text) };
    }
    return np;
  });
  return { ...msg, id, role, parts };
}

export function normalizeMessages(msgs: Message[]): Message[] {
  return msgs.map(normalizeMessage);
}

export function upsertMessage(messages: Message[], msg: Message): Message[] {
  const idx = messages.findIndex((m) => m.id === msg.id);
  if (idx === -1) {
    if (msg.role === "user" && !isLocalMessage(msg.id)) {
      // Correlate by explicit text content (oldest match wins), never by
      // "the first local_ found" — parallel sends must not swap counterparts.
      const localIdx = findLocalUserMessageIndex(messages, msg);
      if (localIdx !== -1) {
        const copy = messages.slice();
        const existingLocal = copy[localIdx];
        if (existingLocal) {
          const parts =
            msg.parts && msg.parts.length > 0 ? msg.parts : existingLocal.parts;
          copy[localIdx] = { ...msg, parts };
          return copy;
        }
      }
    }
    return [...messages, { ...msg, parts: msg.parts ?? [] }];
  }
  const copy = messages.slice();
  // Preserve existing parts: an info-only update (e.g. final tokens at end of
  // turn) must NOT blank out the accumulated text/tool parts.
  const existing = copy[idx];
  if (!existing) return [...messages, { ...msg, parts: msg.parts ?? [] }];
  const incoming = msg as Message;
  const parts =
    incoming.parts && incoming.parts.length > 0
      ? incoming.parts
      : existing.parts;
  const { parts: _omit, ...rest } = msg;
  copy[idx] = { ...existing, ...rest, parts } as Message;
  if (msg.role === "user" && !isLocalMessage(msg.id)) {
    // Drop only the optimistic counterpart(s) of THIS confirmed message;
    // other pending optimistic sends must survive.
    const confirmedTexts = userMessageTexts(msg);
    return copy.filter((m) => {
      if (m.id === msg.id || !isLocalMessage(m.id)) return true;
      for (const text of userMessageTexts(m)) {
        if (confirmedTexts.has(text)) return false;
      }
      return true;
    });
  }
  return copy;
}

export function patchPart(
  messages: Message[],
  messageID: string,
  part: Part,
): Message[] {
  const cleanedPart0 = normalizePartTool(part);
  const targetID = messageID;
  const exists = messages.some((m) => m.id === targetID);
  if (!exists) {
    const cleanedPart = isTextPart(cleanedPart0)
      ? { ...cleanedPart0, text: cleanSysText(cleanedPart0.text) }
      : cleanedPart0;
    // Adopt a local optimistic user message only on an explicit text match:
    // an unknown messageID may just as well carry the first assistant tokens,
    // and a positional/"single pending" guess would render them inside the
    // user's bubble.
    const localIdx = isTextPart(cleanedPart)
      ? findLocalUserMessageIndex(
          messages,
          { id: targetID, role: "user", parts: [cleanedPart] },
          { textMatchOnly: true },
        )
      : -1;
    const localMsg = localIdx !== -1 ? messages[localIdx] : undefined;
    if (localMsg) {
      const copy = messages.slice();
      copy[localIdx] = {
        ...localMsg,
        id: targetID,
        parts: [cleanedPart],
      };
      return copy;
    }
    return [
      ...messages,
      { id: targetID, role: "assistant", parts: [cleanedPart0] },
    ];
  }
  return messages.map((m) => {
    if (m.id !== targetID) return m;
    const cleanedPart =
      m.role === "user" && isTextPart(cleanedPart0)
        ? { ...cleanedPart0, text: cleanSysText(cleanedPart0.text) }
        : cleanedPart0;
    const pid = hasId(cleanedPart) ? cleanedPart.id : undefined;
    let idx = pid ? m.parts.findIndex((p) => hasId(p) && p.id === pid) : -1;
    if (idx === -1) {
      idx = m.parts.findIndex(
        (p) =>
          !hasId(p) &&
          p.type === cleanedPart.type &&
          (m.role === "user" ||
            (isTextPart(p) &&
              isTextPart(cleanedPart) &&
              p.text === cleanedPart.text)),
      );
      if (
        idx === -1 &&
        m.parts.length === 1 &&
        m.parts[0] !== undefined &&
        m.parts[0].type === cleanedPart.type &&
        !hasId(m.parts[0]) &&
        (m.parts[0].type !== "tool" ||
          ((m.parts[0] as { tool?: string }).tool ===
            (cleanedPart as { tool?: string }).tool &&
            (m.parts[0] as { status?: string }).status !== "completed"))
      ) {
        idx = 0;
      }
    }
    if (idx === -1 || idx >= m.parts.length)
      return { ...m, parts: [...m.parts, cleanedPart] };
    const parts = m.parts.slice();
    const target = parts[idx];
    if (target === undefined) return { ...m, parts: [...m.parts, cleanedPart] };
    parts[idx] = { ...target, ...cleanedPart };
    return { ...m, parts };
  });
}

/**
 * Применяет дельту к полю части. Поддерживает вложенные пути через точку
 * (например "state.output" у tool-частей): строковые дельты дописываются
 * в конец, прочие значения заменяют текущее. Объекты по пути копируются
 * (immutable-обновление), чтобы memo-компоненты увидели изменение.
 * Раньше вложенное поле записывалось как литеральный ключ "state.output"
 * и терялось — из-за этого вывод в карточках действий появлялся только
 * после финального message.part.updated, а не стримился.
 */
function applyFieldDelta(
  target: Record<string, unknown>,
  field: string,
  delta: unknown,
): void {
  const keys = field.split(".");
  let obj = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string;
    const cur = obj[key];
    obj[key] =
      cur && typeof cur === "object" && !Array.isArray(cur)
        ? { ...(cur as Record<string, unknown>) }
        : {};
    obj = obj[key] as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1] as string;
  const cur = obj[leaf];
  if (typeof cur === "string" || typeof delta === "string") {
    const next = String(delta);
    const prev = typeof cur === "string" ? cur : "";
    // Повтор длинной SSE-дельты после реконнекта: короткий токен вроде «с»
    // всё равно дописываем, иначе стрим встанет. Пропускаем только кусок,
    // который уже есть как суффикс или как начало текущего текста.
    if (next.length >= 12 && (prev.endsWith(next) || prev.startsWith(next)))
      return;
    obj[leaf] = prev + next;
  } else {
    obj[leaf] = delta;
  }
}

export function patchPartDelta(
  messages: Message[],
  messageID: string,
  partID: string,
  field: string,
  delta: unknown,
): Message[] {
  if (!messageID || !partID || !field || delta === undefined) return messages;
  const exists = messages.some((m) => m.id === messageID);
  if (!exists) {
    // Delta arrived before the part itself. For non-text fields we don't know
    // the real part type yet — mark it "stub" so PartView hides it until
    // message.part.updated brings the real type (patchPart merges it in).
    const stubPart: Record<string, unknown> = {
      id: partID,
      type: field === "text" ? "text" : "stub",
    };
    applyFieldDelta(stubPart, field, delta);
    return [
      ...messages,
      {
        id: messageID,
        role: "assistant",
        parts: [normalizePartTool(stubPart as Part)],
      },
    ];
  }
  return messages.map((m) => {
    if (m.id !== messageID) return m;
    const idx = m.parts.findIndex((p) => (p as { id?: string }).id === partID);
    if (idx === -1) {
      const newPart: Record<string, unknown> = {
        id: partID,
        type: field === "text" ? "text" : "stub",
      };
      applyFieldDelta(newPart, field, delta);
      return { ...m, parts: [...m.parts, normalizePartTool(newPart as Part)] };
    }
    const parts = m.parts.slice();
    const existingPart = parts[idx];
    if (existingPart === undefined) {
      const newPart: Record<string, unknown> = {
        id: partID,
        type: field === "text" ? "text" : "stub",
      };
      applyFieldDelta(newPart, field, delta);
      return { ...m, parts: [...m.parts, normalizePartTool(newPart as Part)] };
    }
    const target = { ...existingPart } as Record<string, unknown>;
    applyFieldDelta(target, field, delta);
    parts[idx] = target as Part;
    return { ...m, parts };
  });
}
