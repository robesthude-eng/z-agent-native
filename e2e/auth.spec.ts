import { expect, test } from "@playwright/test";

// Selectors below come from src/components/LoginPage.tsx (#email, #password,
// #confirm and the Russian button labels). If that markup changes these tests
// should fail loudly rather than be loosened.

const uniqueEmail = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test.describe("authentication", () => {
	test("unauthenticated visit renders the login form", async ({ page }) => {
		await page.goto("/");

		await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
		await expect(page.locator("#password")).toBeVisible();
		// The confirm field belongs to the registration tab only.
		await expect(page.locator("#confirm")).toHaveCount(0);
	});

	test("registration rejects a short password before hitting the server", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Регистрация" }).click();

		await page.locator("#email").fill(uniqueEmail());
		await page.locator("#password").fill("12345");
		await page.locator("#confirm").fill("12345");
		await page.getByRole("button", { name: "Зарегистрироваться" }).click();

		await expect(page.getByText("Пароль должен содержать минимум 6 символов.")).toBeVisible();
	});

	test("registration rejects mismatched passwords", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Регистрация" }).click();

		await page.locator("#email").fill(uniqueEmail());
		await page.locator("#password").fill("correct-horse");
		await page.locator("#confirm").fill("correct-horse-typo");
		await page.getByRole("button", { name: "Зарегистрироваться" }).click();

		await expect(page.getByText("Пароли не совпадают.")).toBeVisible();
	});

	test("a registered user reaches the app and gets an HttpOnly session cookie", async ({
		page,
		context,
	}) => {
		const email = uniqueEmail();

		await page.goto("/");
		await page.getByRole("button", { name: "Регистрация" }).click();
		await page.locator("#email").fill(email);
		await page.locator("#password").fill("correct-horse");
		await page.locator("#confirm").fill("correct-horse");
		await page.getByRole("button", { name: "Зарегистрироваться" }).click();

		// The login form is gone once the session is established.
		await expect(page.locator("#password")).toHaveCount(0, { timeout: 15_000 });

		const cookies = await context.cookies();
		const session = cookies.find((c) => c.name === "z_agent_session");
		const csrf = cookies.find((c) => c.name === "z_agent_csrf");

		expect(session, "session cookie must be set").toBeTruthy();
		// Stealing the session via injected JS must stay impossible.
		expect(session?.httpOnly).toBe(true);
		// The CSRF token has to be readable by the SPA to be echoed back.
		expect(csrf, "csrf cookie must be set").toBeTruthy();
		expect(csrf?.httpOnly).toBe(false);
	});

	test("a deep link falls back to the SPA instead of a 404", async ({ page }) => {
		const response = await page.goto("/session/does-not-exist");

		expect(response?.status()).toBe(200);
		await expect(page.locator("#email")).toBeVisible();
	});
});
