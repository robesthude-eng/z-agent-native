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

test('normal provider research reply survives rendering and reload', async ({ page }) => {
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
  await composer.fill('Покажи документацию OpenCode. FIXTURE_PROVIDER_RESEARCH_REPLY');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  const heading = page.getByRole('heading', { name: 'Документация OpenCode', exact: true });
  await expect(heading).toBeVisible({ timeout: 25000 });
  await expect(page.getByRole('link', { name: 'opencode.ai', exact: true })).toHaveAttribute('href', 'https://opencode.ai/docs/zen/');
  await expect(page.locator('.chat-assistant')).toContainText('{"model":"example-model"}');
  await expect(page.locator('.chat-assistant')).toContainText('Model is unavailable');
  await expect(page.locator('.chat-assistant')).not.toContainText('Эта модель сейчас недоступна у провайдера');
  await expect(page.getByTestId('turn-summary-card')).toBeVisible();
  await page.reload();
  await expect(heading).toBeVisible();
  await expect(page.getByRole('link', { name: 'opencode.ai', exact: true })).toBeVisible();
  await heading.scrollIntoViewIfNeeded();
  await snapshot(page, 'research-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await heading.scrollIntoViewIfNeeded();
  await snapshot(page, 'research-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
