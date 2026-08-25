import { describe, expect, test } from "vitest";
import { parseRuntimeCapabilities } from "./runtimeCapabilities";

describe("parseRuntimeCapabilities", () => {
  test("accepts the safe capability snapshot", () => {
    const snapshot = parseRuntimeCapabilities({
      runtime: "z-agent-native",
      version: "1.0.0",
      capabilities: {
        shell: { state: "ready", mode: "isolated-executor", required: true },
        ssh: { state: "disabled", mode: "off", allowlistCount: 0 },
      },
      policies: { web: "off", ssh: "off" },
      tools: ["read", "write", "bash"],
    });
    expect(snapshot?.capabilities.shell).toEqual({
      state: "ready",
      mode: "isolated-executor",
      required: true,
    });
    expect(snapshot?.capabilities.ssh.state).toBe("disabled");
    expect(snapshot?.tools).toEqual(["read", "write", "bash"]);
  });

  test("rejects malformed network data", () => {
    expect(parseRuntimeCapabilities(null)).toBeNull();
    expect(parseRuntimeCapabilities({ runtime: "z-agent-native" })).toBeNull();
  });
});
