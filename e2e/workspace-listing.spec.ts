import { expect, test } from "@playwright/test";

test("root artifacts remain visible when recursive listing is limited or an old server truncates it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Регистрация" }).click();
  await page.locator("#email").fill(`tree-${Date.now()}@example.com`);
  await page.locator("#password").fill("correct-horse");
  await page.locator("#confirm").fill("correct-horse");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  const composer = page.getByRole("textbox", { name: "Сообщение ассистенту" });
  await expect(composer).toBeVisible();
  const tour = page.getByRole("button", { name: "Пропустить знакомство" });
  if (await tour.isVisible()) await tour.click();
  await composer.fill("E2E fixture: create a tiny module, verify it with a regression test, and report completion.");
  await page.getByRole("button", { name: "Отправить сообщение" }).click();
  await expect(page.getByText(/Fixture task completed and verified: hello\.js/i)).toBeVisible({ timeout: 25_000 });
  await page.evaluate(async () => {
    const sessions = await fetch("/api/session", { credentials: "include" }).then(r => r.json());
    const sid = sessions[0].id;
    const csrf = decodeURIComponent(document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith("z_agent_csrf="))?.split("=")[1] || "");
    for (const body of [{ path: ".venv", type: "directory" }, { path: "vk-noads-8.193-arm64.xapk", content: "binary fixture artifact" }]) {
      const res = await fetch(`/api/workspace/file?sessionId=${encodeURIComponent(sid)}`, { method: body.type ? "POST" : "PUT", credentials: "include", headers: { "Content-Type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`fixture creation: ${res.status}`);
    }
  });
  let legacy = false;
  const truncatedNodes = Array.from({ length: 10_000 }, (_, i) => ({ path: `.venv/lib/file-${i}.py`, type: "file", isDirectory: false }));
  await page.route("**/api/workspace/tree?**", route => route.fulfill({ status: legacy ? 200 : 409, contentType: "application/json", body: JSON.stringify(legacy ? truncatedNodes : { error: "Recursive listing limit reached" }) }));
  await page.getByTestId("workspace-toggle").click();
  await expect(page.getByText("vk-noads-8.193-arm64.xapk", { exact: true })).toBeVisible();
  legacy = true;
  const rootRefresh = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/file" && url.searchParams.get("path") === "." && response.request().method() === "GET";
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await rootRefresh;
  await expect(page.getByText("vk-noads-8.193-arm64.xapk", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("vk-noads-8.193-arm64.xapk", { exact: true })).toBeVisible();
});
