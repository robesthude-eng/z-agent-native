// Release 4: property-based (fuzz) tests for mergeMessages on a seeded PRNG.
// Seeds are fixed in a loop, so any failure is deterministically reproducible;
// the failing seed is included in every assertion message.
import { describe, expect, it } from "vitest";
import { isLocalMessage } from "../lib/ids";
import { mergeMessages } from "./messageMerge";
import type { Message } from "./types";

type Rnd = () => number;

// mulberry32 - tiny deterministic PRNG (no dependencies, no network).
function mulberry32(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rnd: Rnd, max: number): number {
  return Math.floor(rnd() * max);
}

function pick<T>(rnd: Rnd, arr: readonly T[]): T {
  // Вызывается только с непустыми массивами; индекс всегда в диапазоне.
  return arr[int(rnd, arr.length)] as T;
}

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] as const;

function genText(rnd: Rnd): string {
  const n = 1 + int(rnd, 4);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(rnd, WORDS));
  return out.join(" ");
}

function genParts(rnd: Rnd, msgIdx: number): Message["parts"] {
  const n = 1 + int(rnd, 3);
  const parts: Message["parts"] = [];
  for (let i = 0; i < n; i++) {
    const kind = rnd();
    if (kind < 0.6) {
      parts.push({
        id: `prt_${msgIdx}_${i}`,
        type: "text",
        text: genText(rnd),
      } as Message["parts"][number]);
    } else if (kind < 0.8) {
      parts.push({
        id: `prt_${msgIdx}_${i}`,
        type: "reasoning",
        text: genText(rnd),
      } as Message["parts"][number]);
    } else {
      parts.push({
        id: `prt_${msgIdx}_${i}`,
        type: "tool",
        state: { status: pick(rnd, ["pending", "running", "completed"]) },
      } as Message["parts"][number]);
    }
  }
  return parts;
}

function genServer(rnd: Rnd): Message[] {
  const n = int(rnd, 6);
  const msgs: Message[] = [];
  for (let i = 0; i < n; i++) {
    const role = rnd() < 0.4 ? "user" : "assistant";
    const msg = { id: `msg_${i}`, role, parts: genParts(rnd, i) } as Message;
    if (role === "assistant" && rnd() < 0.4) {
      msg.info =
        rnd() < 0.5
          ? ({ finish: "stop" } as Message["info"])
          : ({ time: { completed: 1 } } as Message["info"]);
    }
    msgs.push(msg);
  }
  return msgs;
}

// Local store state: a subset of server messages with mutations applied
// (prefix-extended streaming text, truncated text, upgraded tool status)
// plus extra local-only messages (optimistic local_ and plain ids).
function genLocal(rnd: Rnd, server: Message[]): Message[] {
  const local: Message[] = [];
  for (const s of server) {
    if (rnd() < 0.3) continue; // server knows it, local has not seen it yet
    const parts = s.parts.map((p) => {
      if ((p.type === "text" || p.type === "reasoning") && rnd() < 0.5) {
        const text = (p as { text?: string }).text || "";
        return rnd() < 0.7
          ? { ...p, text: `${text} ${pick(rnd, WORDS)}` } // prefix extension
          : { ...p, text: text.slice(0, Math.max(0, text.length - 2)) };
      }
      if (p.type === "tool" && rnd() < 0.5) {
        return { ...p, state: { status: "completed" } };
      }
      return p;
    }) as Message["parts"];
    local.push({ ...s, parts });
  }
  const extras = int(rnd, 3);
  for (let i = 0; i < extras; i++) {
    local.push({
      id: rnd() < 0.5 ? `local_${i}` : `usr_${i}`,
      role: "user",
      parts: [{ type: "text", text: genText(rnd) }],
    } as Message);
  }
  return local;
}

describe("mergeMessages: property-based (fuzz)", () => {
  it("invariants hold across 300 random scenarios", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed);
      const server = genServer(rnd);
      const local = genLocal(rnd, server);
      const serverSnap = JSON.stringify(server);
      const localSnap = JSON.stringify(local);
      const tag = `seed=${seed}`;

      const merged = mergeMessages(server, local);

      // 1. Inputs are never mutated.
      expect(JSON.stringify(server), tag).toBe(serverSnap);
      expect(JSON.stringify(local), tag).toBe(localSnap);

      // 2. Message ids are unique.
      const ids = merged.map((m) => m.id);
      expect(new Set(ids).size, tag).toBe(ids.length);

      // 3. Every server message is present, in server order.
      const serverIds = new Set(server.map((m) => m.id));
      expect(
        ids.filter((id) => serverIds.has(id)),
        tag,
      ).toEqual(server.map((m) => m.id));

      // 4. Non-optimistic local messages are never lost.
      for (const l of local) {
        if (!isLocalMessage(l.id)) {
          expect(ids.includes(l.id), `${tag} lost ${l.id}`).toBe(true);
        }
      }

      // 5. Determinism: calling again yields a deep-equal result.
      expect(mergeMessages(server, local), tag).toEqual(merged);

      // 6. Idempotency: re-merging on top of the result is stable -
      //    this is exactly how the HTTP poller re-applies snapshots.
      expect(mergeMessages(server, merged), tag).toEqual(merged);
    }
  });

  it("streamed text never rolls back until the server finalizes", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rnd = mulberry32(seed * 7919);
      const sText = genText(rnd);
      const lText = `${sText} ${pick(rnd, WORDS)}`;
      const final = rnd() < 0.5;
      const server: Message[] = [
        {
          id: "msg_0",
          role: "assistant",
          parts: [{ id: "prt_0", type: "text", text: sText }],
          ...(final ? { info: { finish: "stop" } } : {}),
        } as Message,
      ];
      const local: Message[] = [
        {
          id: "msg_0",
          role: "assistant",
          parts: [{ id: "prt_0", type: "text", text: lText }],
        } as Message,
      ];
      const merged = mergeMessages(server, local);
      const text = (merged[0]?.parts[0] as { text?: string })?.text;
      // Final: server is authoritative. Not final: longer local text wins.
      expect(text, `seed=${seed}`).toBe(final ? sText : lText);
    }
  });
});
