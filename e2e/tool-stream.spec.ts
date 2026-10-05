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

test('running tool cards show live stdout and stderr before completion', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('z-agent:theme', 'dark'));
  await page.setViewportSize({ width: 390, height: 844 });
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
  await composer.fill('Проверь вывод команды. FIXTURE_LIVE_TOOL_OUTPUT');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByText('Ожидаем вывод команды…', { exact: true })).toBeVisible({ timeout: 25000 });
  const card = page.locator('.group.not-prose').filter({ has: page.locator('.chat-tool-label', { hasText: 'Команда' }) }).last();
  await expect(card.locator('pre')).toContainText('STREAM_FIRST', { timeout: 10000 });
  await expect(card.locator('pre')).toContainText('STREAM_WARNING');
  await expect(card).toContainText('Работает');
  await expect(card.locator('pre')).not.toContainText('STREAM_LAST');
  await expect(page.getByRole('button', { name: 'Остановить генерацию' })).toBeVisible();
  await snapshot(page, 'tool-stream-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  await snapshot(page, 'tool-stream-desktop');
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeVisible({ timeout: 15000 });
  await card.locator('.chat-tool-toggle').click();
  await expect(card.locator('pre')).toContainText('STREAM_LAST');
  await expect(card.locator('pre')).toContainText('exit=0');
});
