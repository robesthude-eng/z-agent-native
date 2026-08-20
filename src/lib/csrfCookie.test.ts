import { describe, expect, it } from "vitest";
import { csrfHeaders, readCsrfCookie } from "./csrfCookie";

describe("readCsrfCookie", () => {
  it("prefers the __Host- cookie when a leftover unprefixed cookie is present", () => {
    expect(
      readCsrfCookie("z_agent_csrf=stale-legacy-token-value; __Host-z_agent_csrf=fresh-host-token-value"),
    ).toBe("fresh-host-token-value");
  });

  it("still reads the unprefixed cookie on non-HTTPS / e2e", () => {
    expect(readCsrfCookie("z_agent_csrf=only-legacy-token-value")).toBe(
      "only-legacy-token-value",
    );
  });

  it("returns empty when neither cookie exists", () => {
    expect(readCsrfCookie("other=1")).toBe("");
    expect(csrfHeaders("other=1")).toEqual({});
  });

  it("puts the preferred token on x-csrf-token", () => {
    expect(
      csrfHeaders("z_agent_csrf=stale-legacy-token-value; __Host-z_agent_csrf=fresh-host-token-value"),
    ).toEqual({ "x-csrf-token": "fresh-host-token-value" });
  });
});
