// Release 4: property-based (fuzz) test for SessionFsm. Random operation
// sequences are checked against a simple reference model (oracle) after
// every step. Seeds are fixed, failures are reproducible; the seed is
// included in every assertion message.
import { describe, expect, it } from "vitest";
import { SessionFsm } from "./sessionFsm";

type Rnd = () => number;

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

const SIDS = ["a", "b", "c"] as const;

describe("SessionFsm: property-based (fuzz)", () => {
  it("matches the reference model over 200 random sequences", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const tag = `seed=${seed}`;
      const rnd = mulberry32(seed);
      const fsm = new SessionFsm();

      // Reference model (oracle).
      const gens = new Map<string, number>();
      const active = new Map<string, number>();
      // sid -> gen -> indices of registered callbacks (chain order).
      const registry = new Map<string, Map<number, number[]>>();
      const issued: Array<{ sid: string; gen: number }> = [];
      const calls: number[] = []; // actual invocation counts
      const expected: number[] = []; // model-predicted invocation counts

      const resolveInModel = (sid: string) => {
        const bySid = registry.get(sid);
        if (!bySid) return false;
        for (const list of bySid.values()) {
          for (const i of list) expected[i] = (expected[i] ?? 0) + 1;
        }
        registry.delete(sid);
        return true;
      };

      for (let step = 0; step < 60; step++) {
        const sid = pick(rnd, SIDS);
        const op = int(rnd, 7);
        if (op === 0) {
          const gen = fsm.beginRequest(sid);
          const g = (gens.get(sid) ?? 0) + 1;
          expect(gen, tag).toBe(g);
          gens.set(sid, g);
          active.set(sid, g);
          issued.push({ sid, gen: g });
        } else if (op === 1) {
          fsm.markIdle(sid); // legacy: unconditional
          active.delete(sid);
        } else if (op === 2 && issued.length > 0) {
          const req = pick(rnd, issued);
          fsm.markIdle(req.sid, req.gen);
          if (active.get(req.sid) === req.gen) active.delete(req.sid);
        } else if (op === 3) {
          const idx = calls.length;
          calls.push(0);
          expected.push(0);
          const mine = issued.filter((x) => x.sid === sid);
          const useGen =
            rnd() < 0.5 && mine.length > 0 ? pick(rnd, mine).gen : undefined;
          fsm.onIdle(
            sid,
            () => {
              calls[idx] = (calls[idx] ?? 0) + 1;
            },
            useGen,
          );
          const g = useGen ?? gens.get(sid) ?? 0;
          let bySid = registry.get(sid);
          if (!bySid) {
            bySid = new Map();
            registry.set(sid, bySid);
          }
          const list = bySid.get(g) ?? [];
          list.push(idx);
          bySid.set(g, list);
        } else if (op === 4) {
          const had = (registry.get(sid)?.size ?? 0) > 0;
          expect(fsm.resolveIdle(sid), `${tag} step=${step}`).toBe(had);
          resolveInModel(sid);
        } else if (op === 5) {
          fsm.clearIdleResolver(sid); // legacy: drop all generations
          registry.delete(sid);
        } else if (op === 6 && issued.length > 0) {
          const req = pick(rnd, issued);
          fsm.clearIdleResolver(req.sid, req.gen);
          const bySid = registry.get(req.sid);
          if (bySid) {
            bySid.delete(req.gen);
            if (bySid.size === 0) registry.delete(req.sid);
          }
        }

        // Invariant: busy state matches the model after every step.
        for (const s of SIDS) {
          expect(fsm.isBusy(s), `${tag} step=${step} sid=${s}`).toBe(
            active.has(s),
          );
        }
        // Invariant: no resolver ever fires twice (or too early).
        expect(calls, `${tag} step=${step}`).toEqual(expected);
      }

      // Drain: every live resolver fires exactly once, cleared ones never.
      for (const s of SIDS) {
        const had = (registry.get(s)?.size ?? 0) > 0;
        expect(fsm.resolveIdle(s), tag).toBe(had);
        resolveInModel(s);
      }
      expect(calls, tag).toEqual(expected);
    }
  });
});
