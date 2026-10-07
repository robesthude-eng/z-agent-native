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

test('user bubbles keep short words intact, wrap long text and preserve newlines', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('z-agent:theme', 'dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Регистрация' }).click();
  await page.locator('#email').fill(`bubble-${Date.now()}@example.com`);
  await page.locator('#password').fill('correct-horse');
  await page.locator('#confirm').fill('correct-horse');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  const composer = page.getByRole('textbox', { name: 'Сообщение ассистенту' });
  await expect(composer).toBeVisible();
  const tour = page.getByRole('button', { name: 'Пропустить знакомство' });
  if (await tour.isVisible()) await tour.click();
  await page.keyboard.press('Escape');
  const send = async (text: string) => {
    await composer.fill(text);
    await page.getByRole('button', { name: 'Отправить сообщение' }).click();
    await expect.poll(() => page.evaluate(async expected => {
      const sessions = await fetch('/api/session').then(res => res.json()) as { id: string }[];
      if (!sessions[0]) return false;
      const messages = await fetch(`/api/session/${sessions[0].id}/message`).then(res => res.json()) as {
        role: string; parts?: { type?: string; text?: string }[];
        time?: { completed?: number }; info?: { time?: { completed?: number } };
      }[];
      const user = messages.findLast(message => message.role === 'user');
      const last = messages.at(-1);
      return user?.parts?.filter(part => part.type === 'text').map(part => part.text).join('\n') === expected
        && last?.role === 'assistant' && Boolean(last.time?.completed || last.info?.time?.completed);
    }, text), { timeout: 25000 }).toBe(true);
    await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeVisible({ timeout: 25000 });
    const user = page.locator('.chat-user').last();
    await user.scrollIntoViewIfNeeded();
    await expect(user.locator('.chat-user-text')).toHaveText(text);
    return user;
  };
  const greeting = await send('Привет');
  const lineCount = async () => {
    await greeting.scrollIntoViewIfNeeded();
    return greeting.locator('.chat-user-text').evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    return range.getClientRects().length;
    });
  };
  expect(await lineCount()).toBe(1);
  await expect(greeting.locator('.chat-message-actions button')).toHaveCount(2);
  await greeting.scrollIntoViewIfNeeded();
  await snapshot(page, 'bubble-mobile-dark');
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeVisible({ timeout: 25000 });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    expect(await lineCount()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await greeting.scrollIntoViewIfNeeded();
  await snapshot(page, 'bubble-mobile-light');
  const multiline = await send('Первая строка\nВторая строка');
  await expect(multiline.locator('.chat-user-text')).toHaveCSS('white-space', 'pre-wrap');
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeVisible({ timeout: 25000 });
  const long = await send(`https://example.com/${'abcdefghij'.repeat(35)}`);
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeVisible({ timeout: 25000 });
  expect(await long.locator('.chat-user-bubble').evaluate(el => {
    const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && el.scrollWidth <= el.clientWidth;
  })).toBe(true);
  await snapshot(page, 'bubble-long-mobile');
  await page.reload();
  await page.locator('.chat-user-text').filter({ hasText: /^Привет$/ }).scrollIntoViewIfNeeded();
  await expect(page.locator('.chat-user-text').filter({ hasText: /^Привет$/ })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[role=log]').evaluate(el => { el.scrollTop = 0; });
  await snapshot(page, 'bubble-desktop');
});
