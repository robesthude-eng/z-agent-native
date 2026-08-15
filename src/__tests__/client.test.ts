/**
 * Tests for src/api/client.ts
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, configure, getConfig } from "../api/client";

// Mock fetch
global.fetch = vi.fn();

describe("client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configure({ baseUrl: "/api" });
  });

  describe("configure", () => {
    test("updates config", () => {
      configure({ baseUrl: "http://localhost:4096" });
      const config = getConfig();
      expect(config.baseUrl).toBe("http://localhost:4096");
    });

    test("merges with existing config", () => {
      configure({ baseUrl: "http://localhost:4096" });
      configure({ username: "test" });
      const config = getConfig();
      expect(config.baseUrl).toBe("http://localhost:4096");
      expect(config.username).toBe("test");
    });
  });

  describe("api.health", () => {
    test("fetches health endpoint", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({ status: "ok" }),
      });

      const result = await api.health();
      expect(result).toEqual({ status: "ok" });
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/global/health",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });
  });

  describe("api.listSessions", () => {
    test("fetches sessions", async () => {
      const sessions = [{ id: "1", title: "Test" }];
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve(sessions),
      });

      const result = await api.listSessions();
      expect(result).toEqual(sessions);
    });
  });

  describe("api.prompt", () => {
    test("sends prompt with correct format", async () => {
      const message = { id: "1", content: "Response" };
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve(message),
      });

      await api.prompt("session-1", "Hello", {
        providerID: "openai",
        modelID: "gpt-4",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/session/session-1/message",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            parts: [{ type: "text", text: "Hello" }],
            model: { providerID: "openai", modelID: "gpt-4" },
          }),
        }),
      );
    });
  });

  describe("error handling", () => {
    test("throws on non-OK response", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("Server error"),
      });

      await expect(api.health()).rejects.toThrow("500 Internal Server Error");
    });

    test("throws on non-JSON response", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        clone: () => ({
          text: () => Promise.resolve("<!DOCTYPE html>"),
        }),
      });

      await expect(api.health()).rejects.toThrow("non-JSON");
    });
  });

  describe("credentials", () => {
    test("sends credentials include for cookie auth", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({}),
      });

      await api.health();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentials: "include",
        }),
      );
    });
  });
});
