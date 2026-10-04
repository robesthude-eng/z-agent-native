import fs from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function snapshot(page: Page, name: string) {
  await fs.mkdir('.e2e-tmp/design', { recursive: true });
  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script').forEach(node => { node.remove(); });
    clone.querySelectorAll<HTMLLinkElement>('link[href]').forEach(node => { node.href = new URL(node.getAttribute('href') || '', location.href).href; });
    return `<!doctype html>${clone.outerHTML}`;
  });
  await fs.writeFile(`.e2e-tmp/design/${name}.html`, html);
}

test('release chat controls: quiet progress, copy/edit icons and no branching action', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => localStorage.setItem('z-agent:theme', 'light'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Регистрация' }).click();
  await page.locator('#email').fill(`controls-${Date.now()}@example.com`);
  await page.locator('#password').fill('correct-horse');
  await page.locator('#confirm').fill('correct-horse');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  const composer = page.getByRole('textbox', { name: 'Сообщение ассистенту' });
  await expect(composer).toBeVisible();
  const tour = page.getByRole('button', { name: 'Пропустить знакомство' });
  if (await tour.isVisible()) await tour.click();
  await page.keyboard.press('Escape');
  await composer.fill('Привет. FIXTURE_RELEASE_CONTROLS');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  {
    const progress = page.getByTestId('agent-progress');
    await expect(progress).toBeVisible();
    await expect(progress.getByRole('status')).toHaveText('Обрабатываю запрос');
    await expect(page.locator('.oc-aura')).toHaveCount(0);
    await expect(page.getByText('пока без внешних действий', { exact: true })).toHaveCount(0);
    const actions = page.locator('.chat-user .chat-message-actions');
    await expect(actions.getByRole('button')).toHaveCount(2);
    await expect(actions).toHaveText('');
    await expect(actions.getByRole('button', { name: 'Изменить сообщение' })).toHaveCSS('width', '44px');
    await expect(page.getByRole('button', { name: /ответв/i })).toHaveCount(0);
    await snapshot(page, 'controls-mobile');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(progress.locator('.agent-progress-dot')).toHaveCSS('animation-name', 'none');
    await snapshot(page, 'controls-dark');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.chat-user').hover();
    await snapshot(page, 'controls-desktop');
  }
  await expect(page.getByText(/Fixture task completed and verified: hello\.js/i)).toBeVisible({ timeout: 25000 });
  await expect(page.getByTestId('agent-progress')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const actions = page.locator('.chat-user .chat-message-actions');
  await actions.getByRole('button', { name: 'Копировать', exact: true }).click();
  await expect(actions.getByRole('button', { name: 'Скопировано' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Привет. FIXTURE_RELEASE_CONTROLS');
  await actions.getByRole('button', { name: 'Изменить сообщение' }).click();
  await expect(page.locator('.chat-user textarea')).toBeFocused();
  await expect(page.locator('.chat-user textarea')).toHaveValue('Привет. FIXTURE_RELEASE_CONTROLS');
  await page.locator('.chat-user textarea').fill('Привет, новый запрос');
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-user .chat-user-text')).toHaveText('Привет. FIXTURE_RELEASE_CONTROLS');
  await expect(page.locator('.chat-assistant .chat-message-actions')).toHaveText('');
  await expect(page.getByRole('button', { name: 'Перегенерировать ответ' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
