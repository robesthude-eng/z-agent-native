/**
 * Раскладка списка чатов.
 *
 * Список чатов — главный навигационный элемент: потерявшийся или удвоившийся
 * чат читается как потеря данных, поэтому проверяем именно состав и порядок
 * групп, а не разметку.
 */

import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../api/types";
import { buildSidebarGroups, dateGroupLabel } from "./chatGrouping";

const NOW = new Date("2026-07-26T12:00:00Z").getTime();
const daysAgo = (n: number) => NOW - n * 86_400_000;

const session = (id: string, title: string, updated = NOW): SessionInfo =>
  ({ id, title, time: { updated } }) as SessionInfo;

const titleOf = (s: SessionInfo) => s.title || "Новый чат";

const base = {
  pinnedSessions: [] as string[],
  titleOf,
  now: NOW,
};

describe("dateGroupLabel", () => {
  it.each([
    [0, "Сегодня"],
    [1, "Вчера"],
    [3, "На этой неделе"],
    [30, "Раньше"],
  ])("labels a chat updated %i day(s) ago", (days, expected) => {
    expect(dateGroupLabel(session("a", "a", daysAgo(days)), NOW)).toBe(
      expected,
    );
  });

  it("falls back to «Раньше» without a timestamp", () => {
    expect(dateGroupLabel({ id: "a", title: "a" } as SessionInfo, NOW)).toBe(
      "Раньше",
    );
  });
});

describe("buildSidebarGroups", () => {
  it("orders sections: pinned, then date groups", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [
        session("s1", "pinned one"),
        session("s3", "loose today"),
        session("s4", "loose old", daysAgo(30)),
      ],
      pinnedSessions: ["s1"],
    });

    expect(groups.map((g) => [g.kind, g.label])).toEqual([
      ["pinned", "📌 Закреплённые"],
      ["date", "Сегодня"],
      ["date", "Раньше"],
    ]);
    expect(groups[1]?.items.map((s) => s.id)).toEqual(["s3"]);
  });

  it("shows a pinned chat only once", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [session("s1", "both")],
      pinnedSessions: ["s1"],
    });
    const appearances = groups.flatMap((g) =>
      g.items.filter((s) => s.id === "s1"),
    );
    expect(appearances).toHaveLength(1);
    expect(groups[0]?.kind).toBe("pinned");
  });

  it("filters by title case-insensitively", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [session("s1", "Рефакторинг"), session("s2", "Тесты")],
      filter: "РЕФАКТ",
    });
    expect(groups.flatMap((g) => g.items.map((s) => s.id))).toEqual(["s1"]);
  });

  it("returns no groups when everything is filtered out", () => {
    expect(
      buildSidebarGroups({
        ...base,
        sessions: [session("s1", "alpha")],
        filter: "zzz",
      }),
    ).toEqual([]);
  });
});
