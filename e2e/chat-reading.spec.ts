import fs from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function snapshot(page: Page, name: string) {
  await fs.mkdir('.e2e-tmp/design', { recursive: true });
  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    const scroll = document.querySelector('[role=log]');
    clone.querySelector('[role=log]')?.setAttribute('data-qa-scroll-top', String(scroll?.scrollTop || 0));
    clone.querySelectorAll('script').forEach(node => { node.remove(); });
    clone.querySelectorAll<HTMLLinkElement>('link[href]').forEach(node => { node.href = new URL(node.getAttribute('href') || '', location.href).href; });
    return `<!doctype html>${clone.outerHTML}`;
  });
  await fs.writeFile(`.e2e-tmp/design/${name}.html`, html);
}

test('readable chat: self-hosted Cyrillic font, Markdown rhythm, compact metadata and scaling', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('z-agent:theme', 'light'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Регистрация' }).click();
  await page.locator('#email').fill(`reading-${Date.now()}@example.com`);
  await page.locator('#password').fill('correct-horse');
  await page.locator('#confirm').fill('correct-horse');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  const composer = page.getByRole('textbox', { name: 'Сообщение ассистенту' });
  await expect(composer).toBeVisible();
  const tour = page.getByRole('button', { name: 'Пропустить знакомство' });
  if (await tour.isVisible()) await tour.click();
  await page.keyboard.press('Escape');
  await composer.fill('Создай небольшой модуль, проверь тестом и понятно объясни результат. FIXTURE_READABLE_REPLY');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByRole('heading', { name: 'Что сделано', exact: true })).toBeVisible({ timeout: 25000 });
  const answer = page.locator('.chat-assistant .oc-prose').last();
  await expect(answer).toHaveCSS('font-size', '17px');
  await expect(answer).toHaveCSS('line-height', '29.75px');
  await expect(page.locator('.chat-user-text')).toHaveCSS('font-size', '17px');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Inter' && font.status === 'loaded'))).toBe(true);
  await expect(page.getByRole('heading', { name: 'Что сделано', exact: true })).toHaveCSS('font-size', '23.8px');
  await expect(page.locator('.chat-tool-toggle').first()).toHaveCSS('min-height', '44px');
  const meta = page.getByTestId('turn-summary-card');
  await expect(meta).not.toHaveAttribute('open', '');
  await meta.locator('summary').click();
  await expect(meta).toHaveAttribute('open', '');
  await expect(meta.getByRole('button', { name: 'hello.js', exact: true })).toBeVisible();
  await meta.locator('summary').click();
  await page.locator('[role=log]').evaluate(el => { el.scrollTop = 0; });
  await snapshot(page, 'reading-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[role=log]').evaluate(async el => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); el.scrollTop = 0; });
  await snapshot(page, 'reading-mobile');
  await page.evaluate(() => { document.documentElement.style.fontSize = '19px'; });
  await expect(answer).toHaveCSS('font-size', '20.1875px');
  await expect(page.locator('.chat-user-text')).toHaveCSS('font-size', '20.1875px');
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; document.documentElement.dataset.theme = 'dark'; });
  await page.locator('[role=log]').evaluate(async el => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); el.scrollTop = 0; });
  await snapshot(page, 'reading-dark');
  await answer.getByRole('heading', { name: 'Пример использования', exact: true }).scrollIntoViewIfNeeded();
  await snapshot(page, 'reading-mobile-detail');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
