/**
 * Cross-device preference reconciliation.
 *
 * This is the rule that decides whose change survives when a phone and a
 * laptop disagree. Getting it wrong is not a crash — it silently reverts the
 * user's work, which is exactly the bug this replaced: renaming a chat on the
 * desktop left the phone showing the old name forever.
 */

import { describe, expect, it } from "vitest";
import type { UserPrefs } from "../api/client";
import {
  type PrefTimestamps,
  type PrefValues,
  reconcilePrefs,
} from "./prefsSync";

const at = (n: number) => 1_700_000_000_000 + n;

const local = (over: Partial<PrefValues> = {}): PrefValues => ({
  theme: "dark",
  sidebarCollapsed: false,
  workspaceOpen: false,
  pinnedSessions: [],
  selectedModel: null,
  onboardingDone: false,
  chatFolders: [],
  chatFolderAssignments: {},
  ...over,
});

describe("reconcilePrefs", () => {
  it("takes the server value when it is newer", () => {
    const server: UserPrefs = { theme: { value: "light", updatedAt: at(200) } };
    const stamps: PrefTimestamps = { theme: at(100) };

    const { apply, timestamps, pushBack } = reconcilePrefs(
      server,
      local(),
      stamps,
    );

    expect(apply.theme).toBe("light");
    expect(timestamps.theme).toBe(at(200));
    expect(pushBack).toEqual({});
  });

  it("keeps and re-sends a newer local change made offline", () => {
    const server: UserPrefs = { theme: { value: "light", updatedAt: at(100) } };
    const stamps: PrefTimestamps = { theme: at(300) };

    const { apply, pushBack } = reconcilePrefs(
      server,
      local({ theme: "mid" }),
      stamps,
    );

    expect(apply.theme).toBeUndefined();
    expect(pushBack.theme).toEqual({ value: "mid", updatedAt: at(300) });
  });

  it("adopts a field the device has never set", () => {
    const server: UserPrefs = {
      pinnedSessions: { value: ["ses_a"], updatedAt: at(10) },
    };

    const { apply, timestamps } = reconcilePrefs(server, local(), {});

    expect(apply.pinnedSessions).toEqual(["ses_a"]);
    expect(timestamps.pinnedSessions).toBe(at(10));
  });

  it("uploads a local field the server has never seen", () => {
    const { apply, pushBack } = reconcilePrefs(
      {},
      local({ pinnedSessions: ["ses_local"] }),
      { pinnedSessions: at(5) },
    );

    expect(apply).toEqual({});
    expect(pushBack.pinnedSessions).toEqual({
      value: ["ses_local"],
      updatedAt: at(5),
    });
  });

  it("does nothing when both sides are untouched", () => {
    const { apply, pushBack } = reconcilePrefs({}, local(), {});

    expect(apply).toEqual({});
    expect(pushBack).toEqual({});
  });

  it("treats equal timestamps as already in sync", () => {
    const server: UserPrefs = {
      workspaceOpen: { value: true, updatedAt: at(50) },
    };

    const { apply, pushBack } = reconcilePrefs(server, local(), {
      workspaceOpen: at(50),
    });

    expect(apply).toEqual({});
    expect(pushBack).toEqual({});
  });

  it("resolves each field independently in one pass", () => {
    const server: UserPrefs = {
      theme: { value: "light", updatedAt: at(500) },
      sidebarCollapsed: { value: true, updatedAt: at(10) },
      selectedModel: {
        value: { providerID: "google", modelID: "gemini-2.5-pro" },
        updatedAt: at(500),
      },
    };
    const stamps: PrefTimestamps = {
      theme: at(100),
      sidebarCollapsed: at(400),
      selectedModel: at(100),
    };

    const { apply, pushBack } = reconcilePrefs(
      server,
      local({ sidebarCollapsed: false }),
      stamps,
    );

    // Server newer → applied.
    expect(apply.theme).toBe("light");
    expect(apply.selectedModel).toEqual({
      providerID: "google",
      modelID: "gemini-2.5-pro",
    });
    // Local newer → sent back, not overwritten.
    expect(apply.sidebarCollapsed).toBeUndefined();
    expect(pushBack.sidebarCollapsed).toEqual({
      value: false,
      updatedAt: at(400),
    });
  });

  it("can clear the selected model from another device", () => {
    const server: UserPrefs = {
      selectedModel: { value: null, updatedAt: at(900) },
    };

    const { apply, timestamps } = reconcilePrefs(
      server,
      local({ selectedModel: { providerID: "google", modelID: "x" } }),
      { selectedModel: at(1) },
    );

    expect(apply.selectedModel).toBeNull();
    expect(timestamps.selectedModel).toBe(at(900));
  });

  it("ignores a server entry with a malformed timestamp", () => {
    const server = {
      theme: { value: "light", updatedAt: "yesterday" },
    } as unknown as UserPrefs;

    const { apply } = reconcilePrefs(server, local(), { theme: at(1) });

    expect(apply.theme).toBeUndefined();
  });
});
