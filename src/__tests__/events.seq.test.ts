// Релиз 5: тесты seq/gap-логики SSE-транспорта (Релиз 4, батч 3):
// дедупликация replay-кадров, дырки в нумерации, сброс счётчика сервера,
// ?lastEventId= при ручном реконнекте и сброс seq при смене сессии.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EventStream } from "../api/events";

type Ev = { data: string; lastEventId?: string | undefined };

class SeqEventSource {
  static instances: SeqEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: Ev) => void) | null = null;
  readyState = 0;
  private listeners: Map<string, Array<(event: Ev) => void>> = new Map();
  constructor(url: string) {
    this.url = url;
    SeqEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event: Ev) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)?.push(handler);
  }
  close() {
    this.readyState = 2;
  }
  /** Кадр с порядковым номером (id: N от прокси) или без него. */
  frame(n: number | null, payload: Record<string, unknown> = {}) {
    const ev = {
      data: JSON.stringify({ type: "message", properties: payload }),
      lastEventId: n === null ? undefined : String(n),
    };
    this.onmessage?.(ev);
    for (const h of this.listeners.get("message") || []) h(ev);
  }
}

(globalThis as { EventSource?: unknown }).EventSource = SeqEventSource;

function connected() {
  const stream = new EventStream("/api/event");
  const received: Array<{ type: string }> = [];
  stream.on((e) => {
    received.push(e);
  });
  stream.connect();
  const es = SeqEventSource.instances.at(-1) as SeqEventSource;
  return { stream, received, es };
}

const msgs = (received: Array<{ type: string }>) =>
  received.filter((e) => e.type === "message").length;
const reconnects = (received: Array<{ type: string }>) =>
  received.filter((e) => e.type === "stream.reconnected").length;

describe("EventStream: нумерация кадров и replay", () => {
  beforeEach(() => {
    SeqEventSource.instances = [];
  });

  test("последовательные кадры доставляются, повторы seq отбрасываются", () => {
    const { received, es } = connected();
    es.frame(1, { n: 1 });
    es.frame(2, { n: 2 });
    es.frame(2, { n: 2 }); // replay-дубликат
    es.frame(1, { n: 1 }); // старый повтор в пределах окна
    expect(msgs(received)).toBe(2);
    expect(reconnects(received)).toBe(0);
  });

  test("кадры без id обрабатываются как раньше (heartbeat/legacy-прокси)", () => {
    const { received, es } = connected();
    es.frame(null, { n: 1 });
    es.frame(null, { n: 2 });
    expect(msgs(received)).toBe(2);
  });

  test("дырка в нумерации: событие доставлено + один stream.reconnected", () => {
    const { received, es } = connected();
    es.frame(1);
    es.frame(5); // кадры 2..4 потеряны — стор должен дотянуть историю
    expect(msgs(received)).toBe(2);
    expect(reconnects(received)).toBe(1);
  });

  test("сброс счётчика сервера (откат >= окна) принимается, история дотягивается", () => {
    const { received, es } = connected();
    es.frame(1000);
    es.frame(3); // 1000-3 >= 500 (RING_REPLAY_WINDOW) — это рестарт, не replay
    expect(msgs(received)).toBe(2);
    expect(reconnects(received)).toBe(1);
  });

  test("ручной реконнект просит replay через ?lastEventId= c последним seq", () => {
    vi.useFakeTimers();
    try {
      const { es } = connected();
      es.frame(41);
      es.frame(42);
      es.onerror?.();
      vi.advanceTimersToNextTimer();
      const next = SeqEventSource.instances.at(-1) as SeqEventSource;
      expect(next).not.toBe(es);
      expect(next.url).toContain("lastEventId=42");
    } finally {
      vi.useRealTimers();
    }
  });

  test("switchSession сбрасывает seq — у каждой сессии своя нумерация", () => {
    const { stream, received, es } = connected();
    es.frame(10);
    stream.switchSession("ses_other");
    const next = SeqEventSource.instances.at(-1) as SeqEventSource;
    next.frame(1, { n: "fresh" }); // меньше 10, но это НЕ повтор — новая сессия
    expect(msgs(received)).toBe(2);
    expect(reconnects(received)).toBe(0);
    stream.close();
  });
});
