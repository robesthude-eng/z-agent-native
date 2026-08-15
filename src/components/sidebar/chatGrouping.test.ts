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
  folders: [] as { id: string; name: string }[],
  assignments: {} as Record<string, string>,
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
  it("orders sections: pinned, folders, then date groups", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [
        session("s1", "pinned one"),
        session("s2", "in folder"),
        session("s3", "loose today"),
        session("s4", "loose old", daysAgo(30)),
      ],
      pinnedSessions: ["s1"],
      folders: [{ id: "f1", name: "Проект X" }],
      assignments: { s2: "f1" },
    });

    expect(groups.map((g) => [g.kind, g.label])).toEqual([
      ["pinned", "📌 Закреплённые"],
      ["folder", "Проект X"],
      ["date", "Сегодня"],
      ["date", "Раньше"],
    ]);
    expect(groups[1]?.items.map((s) => s.id)).toEqual(["s2"]);
    expect(groups[2]?.items.map((s) => s.id)).toEqual(["s3"]);
  });

  it("shows a pinned chat only once, even when it is also in a folder", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [session("s1", "both")],
      pinnedSessions: ["s1"],
      folders: [{ id: "f1", name: "Проект X" }],
      assignments: { s1: "f1" },
    });

    const appearances = groups.flatMap((g) =>
      g.items.filter((s) => s.id === "s1"),
    );
    expect(appearances).toHaveLength(1);
    expect(groups[0]?.kind).toBe("pinned");
  });

  it("keeps an empty folder visible so a freshly created one does not vanish", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [session("s1", "loose")],
      folders: [{ id: "f1", name: "Пустая" }],
    });
    expect(groups.map((g) => g.label)).toContain("Пустая");
  });

  it("hides empty folders while filtering — they are noise in search results", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [session("s1", "alpha"), session("s2", "beta")],
      folders: [{ id: "f1", name: "Пустая" }],
      filter: "alpha",
    });
    expect(groups.map((g) => g.label)).not.toContain("Пустая");
    expect(groups.flatMap((g) => g.items.map((s) => s.id))).toEqual(["s1"]);
  });

  it("returns a chat assigned to a deleted folder to the date groups", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [session("s1", "orphan")],
      folders: [],
      assignments: { s1: "folder-that-no-longer-exists" },
    });
    expect(groups.map((g) => g.kind)).toEqual(["date"]);
    expect(groups[0]?.items.map((s) => s.id)).toEqual(["s1"]);
  });

  it("preserves the user's folder order", () => {
    const groups = buildSidebarGroups({
      ...base,
      sessions: [session("s1", "a"), session("s2", "b")],
      folders: [
        { id: "f2", name: "Вторая" },
        { id: "f1", name: "Первая" },
      ],
      assignments: { s1: "f1", s2: "f2" },
    });
    expect(
      groups.filter((g) => g.kind === "folder").map((g) => g.label),
    ).toEqual(["Вторая", "Первая"]);
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
