import { expect, test } from "@playwright/test";

const skill = `---\nname: e2e-design-skill\ndescription: Review interfaces and accessibility.\nlicense: MIT\n---\nInspect the UI and check keyboard navigation.\n`;

test("upload portable skill, configure chat, persist choices and disable globally", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Регистрация" }).click();
  await page.locator("#email").fill(`skills-${Date.now()}@example.com`);
  await page.locator("#password").fill("correct-horse");
  await page.locator("#confirm").fill("correct-horse");
  await page.getByRole("button", { name: "Зарегистрироваться" }).click();
  await expect(page.getByRole("textbox", { name: "Сообщение ассистенту" })).toBeVisible();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Память и навыки", exact: true }).click();
  await page.getByLabel("Загрузить скилл", { exact: true }).setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from(skill) });
  await expect(page.getByRole("button", { name: "Установить", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Установить", exact: true }).click();
  await expect(page.getByLabel("Включён в библиотеке")).toBeChecked();
  await page.screenshot({ path: ".e2e-tmp/skills-library-desktop.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Скиллы: автовыбор/ }).click();
  await page.getByLabel("Режим скиллов", { exact: true }).selectOption("manual");
  await page.getByLabel("e2e-design-skill", { exact: true }).check();
  await expect(page.getByRole("button", { name: /1 закреплено/ })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /Скиллы: выбранные/ }).click();
  await expect(page.getByLabel("e2e-design-skill", { exact: true })).toBeChecked();
  await page.getByLabel("Режим скиллов", { exact: true }).selectOption("off");
  await expect(page.getByRole("button", { name: /Скиллы: выключены/ })).toBeVisible();
  await page.screenshot({ path: ".e2e-tmp/skills-chat-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".e2e-tmp/skills-chat-mobile.png", fullPage: true });
});
