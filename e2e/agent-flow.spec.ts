import { expect, test } from "@playwright/test";

const uniqueEmail = () => `e2e-agent-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

async function register(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Регистрация" }).click();
  await page.locator("#email").fill(uniqueEmail());
  await page.locator("#password").fill("correct-horse");
  await page.locator("#confirm").fill("correct-horse");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await expect(page.locator("#password")).toHaveCount(0, { timeout: 15_000 });
}

test.describe("native coding-agent flow", () => {
  test("browser -> agent -> tools -> verification -> SSE/UI -> workspace", async ({ page }) => {
    await register(page);

    const composer = page.getByRole("textbox", { name: "Сообщение ассистенту" });
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("E2E fixture: create a tiny module, verify it with a regression test, and report completion.");

    const send = page.getByRole("button", { name: "Отправить сообщение" });
    await expect(send).toBeEnabled({ timeout: 15_000 });
    await send.click();

    // This text only arrives after the fixture provider has issued two writes,
    // run_tests has passed and the native completion gate allows finalization.
    await expect(page.getByText(/Fixture task completed and verified: hello\.js/i)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole("button", { name: "Отправить сообщение" })).toBeVisible();

    const evidence = await page.evaluate(async () => {
      const sessions = await fetch("/api/session", { credentials: "include" }).then((res) => res.json());
      const sid = sessions[0]?.id;
      if (!sid) throw new Error("no materialized session");
      const messages = await fetch(`/api/session/${sid}/message`, { credentials: "include" }).then((res) => res.json());
      const assistant = [...messages].reverse().find((message: any) => message.role === "assistant");
      const file = await fetch(`/api/file/content?sessionId=${encodeURIComponent(sid)}&path=hello.js`, { credentials: "include" }).then((res) => res.json());
      return {
        sid,
        content: file.content,
        tools: (assistant?.parts ?? []).filter((part: any) => part.type === "tool").map((part: any) => ({ tool: part.tool, status: part.state?.status })),
        telemetry: assistant?.info?.telemetry ?? null,
        strategy: assistant?.info?.strategy ?? null,
      };
    });

    expect(evidence.content).toContain("hello from fixture");
    expect(evidence.tools.filter((item) => item.tool === "write" && item.status === "completed")).toHaveLength(2);
    expect(evidence.tools.some((item) => item.tool === "run_tests" && item.status === "completed")).toBe(true);
    expect(evidence.strategy?.lastVerificationOk).toBe(true);
    expect(evidence.telemetry?.toolCalls).toBeGreaterThanOrEqual(3);
    expect(evidence.telemetry?.outcome).toBe("completed");
  });
});
