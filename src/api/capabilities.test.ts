import { describe, expect, it } from "vitest";
import {
  CAPABILITY_KINDS,
  type CapabilityState,
  canOpen,
  capabilityGate,
  parseCapabilities,
  parsePreviewPath,
  reasonFor,
} from "./capabilities";

/**
 * Решение «что состояние возможности означает для интерфейса» (I-31).
 *
 * Часть этапа 2.3, проверяемая без стора, сети и браузера, — поэтому она и
 * вынесена в отдельный модуль. Сюда же переехал гейт кнопки: внутри `TopBar`
 * его проверял бы только рендер, то есть проверялся бы React, а не правило.
 * В компоненте остался опрос.
 */

const CLOSED: (CapabilityState | null)[] = [
  "unavailable",
  "provisioning",
  "failed",
  "detaching",
  null,
];

describe("canOpen", () => {
  it("ready и active открывать можно", () => {
    // active — это «уже открыто где-то ещё», и запрещать не за что: терминал и
    // панель файлов допускают несколько вкладок.
    expect(canOpen("ready")).toBe(true);
    expect(canOpen("active")).toBe(true);
  });

  it("всё прочее — нельзя, включая provisioning", () => {
    // Пока окружение поднимается, открытая панель показывала бы пустоту,
    // неотличимую от поломки.
    for (const state of CLOSED) {
      expect(canOpen(state), `${state}`).toBe(false);
    }
  });
});

describe("reasonFor", () => {
  it("когда открывать можно — объяснять нечего", () => {
    expect(reasonFor("terminal", "ready")).toBeNull();
    expect(reasonFor("terminal", "active")).toBeNull();
  });

  it("когда нельзя — причина есть всегда и для каждой возможности", () => {
    // Неактивная кнопка без причины выглядит поломкой интерфейса, поэтому
    // молчаливого случая быть не должно ни одного.
    for (const state of CLOSED) {
      for (const kind of CAPABILITY_KINDS) {
        const reason = reasonFor(kind, state);
        expect(reason, `${kind}/${state}`).toBeTruthy();
        expect(typeof reason).toBe("string");
      }
    }
  });

  it("незнакомое состояние тоже объясняется, а не молчит", () => {
    expect(reasonFor("terminal", "чепуха" as CapabilityState)).toBeTruthy();
  });

  it("у превью причина своя: показывать нечего, а не сломано", () => {
    expect(reasonFor("preview", "unavailable")).toContain("HTML");
  });
});

describe("parsePreviewPath", () => {
  it("берёт безопасное имя HTML из ответа", () => {
    expect(parsePreviewPath({ previewPath: "checkers.html" })).toBe(
      "checkers.html",
    );
    expect(parsePreviewPath({ previewPath: "index.html" })).toBe("index.html");
  });

  it("отбрасывает обход пути и чужой тип", () => {
    expect(parsePreviewPath({ previewPath: "../secret.html" })).toBeNull();
    expect(parsePreviewPath({ previewPath: "dir/page.html" })).toBeNull();
    expect(parsePreviewPath({ previewPath: 1 })).toBeNull();
    expect(parsePreviewPath(null)).toBeNull();
  });
});

describe("parseCapabilities", () => {
  it("разбирает ответ маршрута", () => {
    expect(
      parseCapabilities({
        capabilities: {
          terminal: "ready",
          preview: "unavailable",
          workspace: "ready",
        },
      }),
    ).toEqual({
      terminal: "ready",
      preview: "unavailable",
      workspace: "ready",
    });
  });

  it("частичный ответ: остальное остаётся неизвестным", () => {
    expect(parseCapabilities({ capabilities: { terminal: "ready" } })).toEqual({
      terminal: "ready",
      preview: null,
      workspace: null,
    });
  });

  it("незнакомое слово отвергается, а не пробрасывается в интерфейс", () => {
    expect(
      parseCapabilities({ capabilities: { terminal: "выдумка" } }),
    ).toEqual({ terminal: null, preview: null, workspace: null });
  });

  it("никогда не бросает: ответ приходит по сети", () => {
    for (const junk of [
      null,
      undefined,
      0,
      "",
      [],
      {},
      { capabilities: "строка" },
      { capabilities: [] },
      { capabilities: { terminal: 5 } },
    ]) {
      expect(() => parseCapabilities(junk)).not.toThrow();
      expect(parseCapabilities(junk)).toEqual({
        terminal: null,
        preview: null,
        workspace: null,
      });
    }
  });
});

describe("capabilityGate — что делает кнопка возможности", () => {
  const ALL_STATES: (CapabilityState | null)[] = [
    "unavailable",
    "provisioning",
    "ready",
    "active",
    "failed",
    "detaching",
    null,
  ];
  const TITLE = "Терминал";

  const gate = (over: Partial<Parameters<typeof capabilityGate>[0]> = {}) =>
    capabilityGate({
      kind: "terminal",
      state: "ready",
      sessionReady: true,
      capsFromServer: true,
      fallbackTitle: TITLE,
      ...over,
    });

  it("с выключенным флагом ответ НЕ ЗАВИСИТ от состояния вовсе", () => {
    // Принцип выката: пока флаг выключен, новый путь обязан повторять прежнее
    // поведение. Гейт стоит на каждой кнопке верхнего бара — ошибка здесь
    // отключает интерфейс целиком, поэтому перебор, а не пара случаев.
    for (const kind of CAPABILITY_KINDS) {
      for (const sessionReady of [true, false]) {
        const seen = new Set(
          ALL_STATES.map((state) =>
            JSON.stringify(
              gate({ kind, state, sessionReady, capsFromServer: false }),
            ),
          ),
        );
        expect(seen.size).toBe(1);
      }
    }
  });

  it("с выключенным флагом кнопка неактивна ровно без чата", () => {
    expect(gate({ capsFromServer: false, sessionReady: true })).toEqual({
      disabled: false,
      title: TITLE,
    });
    expect(gate({ capsFromServer: false, sessionReady: false })).toEqual({
      disabled: true,
      title: TITLE,
    });
  });

  it("без чата причина не выдумывается", () => {
    // «Окружение ещё не создано» здесь было бы неправдой: окружение ни при чём,
    // пользователь просто не выбрал чат.
    for (const state of ALL_STATES) {
      expect(gate({ state, sessionReady: false })).toEqual({
        disabled: true,
        title: TITLE,
      });
    }
  });

  it("с включённым флагом активность повторяет canOpen", () => {
    for (const kind of CAPABILITY_KINDS) {
      for (const state of ALL_STATES) {
        expect(gate({ kind, state }).disabled).toBe(!canOpen(state));
      }
    }
  });

  it("неактивная кнопка ВСЕГДА объясняет причину", () => {
    // Неактивная кнопка без объяснения неотличима от сломанной — то же
    // требование, что и к неопределённому состоянию хода (I-32).
    for (const kind of CAPABILITY_KINDS) {
      for (const state of ALL_STATES) {
        const r = gate({ kind, state });
        if (!r.disabled) continue;
        expect(r.title).toBe(reasonFor(kind, state));
        expect(r.title).not.toBe(TITLE);
        expect(r.title.length).toBeGreaterThan(TITLE.length);
      }
    }
  });

  it("доступная кнопка подписана обычным заголовком, а не объяснением", () => {
    for (const kind of CAPABILITY_KINDS) {
      for (const state of ["ready", "active"] as CapabilityState[]) {
        expect(gate({ kind, state })).toEqual({
          disabled: false,
          title: TITLE,
        });
      }
    }
  });

  it("объяснение называет саму возможность, а не «панель вообще»", () => {
    const titles = CAPABILITY_KINDS.map(
      (kind) => gate({ kind, state: "failed" }).title,
    );
    expect(new Set(titles).size).toBe(CAPABILITY_KINDS.length);
  });
});
