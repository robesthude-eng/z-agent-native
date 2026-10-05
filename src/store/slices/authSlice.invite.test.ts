import { afterEach, describe, expect, it, vi } from "vitest";
import type { State } from "../types";
import { createAuthSlice } from "./authSlice";

describe("authSlice.register", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("передаёт код приглашения на сервер", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Неверный код приглашения." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const set = vi.fn();
    const get = () => ({}) as State;
    const slice = createAuthSlice(set as never, get as never, {} as never);
    const res = await slice.register(
      "admin@example.com",
      "password12345",
      "  invite-code  ",
    );
    expect(res).toEqual({ ok: false, error: "Неверный код приглашения." });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "admin@example.com",
      password: "password12345",
      inviteCode: "invite-code",
    });
  });
});
