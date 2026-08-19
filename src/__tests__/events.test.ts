/**
 * Tests for src/api/events.ts
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EventStream } from "../api/events";

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;
  private listeners: Map<string, ((event: { data: string }) => void)[]> =
    new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)?.push(listener);
  }

  close() {
    this.readyState = 2;
  }

  // Helper to simulate receiving an event
  simulateEvent(type: string, data: string) {
    if (type === "message") {
      this.onmessage?.({ data });
    } else {
      this.listeners.get(type)?.forEach((listener) => {
        listener({ data });
      });
    }
  }

  // Helper to simulate error
  simulateError() {
    this.onerror?.();
  }
}

// MockEventSource implements only the subset EventStream touches (url,
// addEventListener, onopen/onerror/onmessage, close), hence the double cast.
globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock });

describe("EventStream", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    localStorageMock.getItem.mockReturnValue(null);
  });

  test("creates EventSource with correct URL", () => {
    const stream = new EventStream("http://localhost:3000/api/event");
    stream.connect();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe(
      "http://localhost:3000/api/event",
    );
  });

  test("waits for a session before opening the default event URL", () => {
    const stream = new EventStream();
    stream.connect();
    expect(MockEventSource.instances).toHaveLength(0);
    expect(stream.status).toBe("idle");
    stream.switchSession("ses_ready");
    expect(MockEventSource.instances[0].url).toBe(
      "/api/event?sessionId=ses_ready",
    );
  });

  test("welcome screen without a session is idle, not a dropped stream", () => {
    const stream = new EventStream();
    expect(stream.status).toBe("idle");
    stream.connect();
    expect(stream.status).toBe("idle");
    expect(MockEventSource.instances).toHaveLength(0);
    stream.switchSession("ses_chat");
    expect(stream.status).toBe("connecting");
    stream.switchSession(null);
    expect(stream.status).toBe("idle");
    expect(MockEventSource.instances).toHaveLength(1);
    stream.close();
  });

  test("dispatches named events to handlers", () =>
    new Promise<void>((done) => {
      const stream = new EventStream("http://localhost:3000/api/event");

      stream.on((event) => {
        expect(event.type).toBe("session.created");
        expect(event.properties).toEqual({ id: "123" });
        done();
      });

      stream.connect();

      // Simulate event after connection
      setTimeout(() => {
        MockEventSource.instances[0].simulateEvent(
          "session.created",
          JSON.stringify({ id: "123" }),
        );
      }, 10);
    }));

  test("dispatches session.idle named events", () =>
    new Promise<void>((done) => {
      const stream = new EventStream("http://localhost:3000/api/event");

      stream.on((event) => {
        expect(event.type).toBe("session.idle");
        done();
      });

      stream.connect();
      setTimeout(() => {
        MockEventSource.instances[0].simulateEvent(
          "session.idle",
          JSON.stringify({ sessionID: "ses_1" }),
        );
      }, 10);
    }));

  test("file watcher event inherits the EventStream session when payload has no sessionID", () =>
    new Promise<void>((done) => {
      const stream = new EventStream(
        "http://localhost:3000/api/event",
        "ses_files",
      );

      stream.on((event) => {
        if (event.type !== "file.watcher.updated") return;
        expect(event.properties.sessionID).toBe("ses_files");
        expect(event.properties).toMatchObject({ path: "src/new.ts" });
        stream.close();
        done();
      });

      setTimeout(() => {
        MockEventSource.instances[0].simulateEvent(
          "file.watcher.updated",
          JSON.stringify({ path: "src/new.ts", event: "add" }),
        );
      }, 10);
    }));

  test("dispatches unnamed valid-JSON events as 'message'", () =>
    new Promise<void>((done) => {
      const stream = new EventStream("http://localhost:3000/api/event");

      stream.on((event) => {
        if (event.type === "message") {
          expect(event.type).toBe("message");
          // Payload безымянного события произвольный и в AppEvent.properties
          // не описан — сверяем его через toMatchObject, а не через каст.
          expect(event.properties).toMatchObject({ hello: "world" });
          done();
        }
      });

      stream.connect();

      setTimeout(() => {
        MockEventSource.instances[0].simulateEvent(
          "message",
          JSON.stringify({ hello: "world" }),
        );
      }, 10);
    }));

  test("emits stream.corrupted on invalid JSON chunks instead of dispatching broken data", () =>
    new Promise<void>((done) => {
      const stream = new EventStream("http://localhost:3000/api/event");

      stream.on((event) => {
        expect(event.type).toBe("stream.corrupted");
        expect(event.properties.raw).toBe("not json at all");
        done();
      });

      stream.connect();

      setTimeout(() => {
        MockEventSource.instances[0].simulateEvent(
          "message",
          "not json at all",
        );
      }, 10);
    }));

  test("reconnects on error", () =>
    new Promise<void>((done) => {
      const stream = new EventStream("http://localhost:3000/api/event");
      stream.connect();

      // Simulate error
      MockEventSource.instances[0].simulateError();

      // Should attempt to reconnect after delay
      setTimeout(() => {
        expect(MockEventSource.instances).toHaveLength(2);
        done();
      }, 1100);
    }));

  test("switches to slow 60s retries after max fast attempts instead of giving up", () => {
    vi.useFakeTimers();
    try {
      const stream = new EventStream("http://localhost:3000/api/event");
      stream.connect();

      // Drive 50 errors through the fast exponential-backoff window;
      // cap each advance so we never tick past the scheduled delay.
      for (let i = 0; i < 50; i++) {
        const inst = MockEventSource.instances[i];
        if (!inst) throw new Error(`missing instance at i=${i}`);
        inst.simulateError();
        // Advance by the scheduled delay for this attempt without
        // skipping over the timer that fires the next connect().
        vi.advanceTimersToNextTimer();
      }

      const afterFast = MockEventSource.instances.length;
      expect(afterFast).toBe(51); // 1 initial + 50 fast retries

      // After the fast window is exhausted, errors should keep
      // producing retries every 60s (never "giving up").
      const slowInstance = MockEventSource.instances[afterFast - 1];
      slowInstance.simulateError();
      // Fast-exhausted retries wait 60s — advance that much and a new
      // EventSource must have been created.
      vi.advanceTimersByTime(60001);
      expect(MockEventSource.instances.length).toBe(afterFast + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cleans up on close", () => {
    const stream = new EventStream("http://localhost:3000/api/event");
    stream.connect();

    const es = MockEventSource.instances[0];
    stream.close();

    expect(es.readyState).toBe(2);
  });

  test("removes handler when unsubscribing", () => {
    const stream = new EventStream("http://localhost:3000/api/event");
    const handler = vi.fn();

    const unsubscribe = stream.on(handler);
    stream.connect();

    unsubscribe();

    // Simulate event
    MockEventSource.instances[0].simulateEvent("session.created", "{}");

    expect(handler).not.toHaveBeenCalled();
  });
});

// P3: конфигурируемый список именованных SSE-событий
describe("EventStream — configurable named types (P3)", () => {
  test("registers custom named event types passed via constructor", () => {
    const stream = new EventStream("http://localhost:3000/api/event", null, [
      "custom.event",
    ]);
    const received: Array<{ type: string }> = [];
    stream.on((e) => {
      received.push(e);
    });
    const es = MockEventSource.instances.at(-1);
    es?.simulateEvent(
      "custom.event",
      JSON.stringify({ type: "custom.event", properties: { foo: 1 } }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("custom.event");
    stream.close();
  });

  test("still registers default named types when none are passed", () => {
    const stream = new EventStream("http://localhost:3000/api/event");
    const received: Array<{ type: string }> = [];
    stream.on((e) => {
      received.push(e);
    });
    const es = MockEventSource.instances.at(-1);
    es?.simulateEvent(
      "session.idle",
      JSON.stringify({ type: "session.idle", properties: {} }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("session.idle");
    stream.close();
  });
});
