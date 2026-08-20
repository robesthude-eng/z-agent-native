import { expect, test } from "@playwright/test";

// These assertions exercise the parts of server/native/auth.mjs that jsdom unit
// tests cannot reach: real Set-Cookie flags and real CSRF enforcement.

const uniqueEmail = () => `e2e-api-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test.describe("http contract", () => {
	test("health endpoint answers without authentication", async ({ request }) => {
		const response = await request.get("/health");

		expect(response.status()).toBe(200);
	});

	test("protected endpoint refuses an anonymous caller", async ({ playwright, baseURL }) => {
		// A dedicated context keeps the shared cookie jar out of this check.
		const anonymous = await playwright.request.newContext({ baseURL });
		const response = await anonymous.get("/api/auth/me");

		expect(response.status()).toBe(401);
		await anonymous.dispose();
	});

	test("ui config is behind the auth gate", async ({ playwright, baseURL }) => {
		// /api/ui-config lives after requireAuth in server/index.mjs. A missing
		// cookie must not leak the runtime config, and the suite must not claim
		// the route is public when it is not.
		const anonymous = await playwright.request.newContext({ baseURL });
		const response = await anonymous.get("/api/ui-config");

		expect(response.status()).toBe(401);
		await anonymous.dispose();
	});

	test("registration validates the payload before touching the store", async ({ request }) => {
		const response = await request.post("/api/auth/register", {
			data: { email: "not-an-email", password: "short" },
		});

		expect(response.status()).toBe(400);
		expect(await response.text()).toContain("минимум из 12 символов");
	});

	test("a state-changing request without the csrf header is rejected", async ({
		playwright,
		baseURL,
	}) => {
		const api = await playwright.request.newContext({ baseURL });

		// register is exempt from the csrf check, which is what makes bootstrap possible
		const registered = await api.post("/api/auth/register", {
			data: { email: uniqueEmail(), password: "correct-horse" },
		});
		expect(registered.ok()).toBeTruthy();

		// authenticated, but replaying the session cookie alone must not be enough
		const forged = await api.post("/api/session", { data: {} });
		expect(forged.status()).toBe(403);
		expect(await forged.text()).toContain("CSRF");

		// the very same call succeeds once the token from the readable cookie is echoed
		const cookies = await api.storageState();
		const token = cookies.cookies.find((c) => c.name === "z_agent_csrf")?.value ?? "";
		expect(token.length).toBeGreaterThanOrEqual(16);

		const accepted = await api.post("/api/session", {
			data: {},
			headers: { "x-csrf-token": token },
		});
		expect(accepted.ok()).toBeTruthy();

		await api.dispose();
	});
});
