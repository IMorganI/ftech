import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const fixtures = () => JSON.parse(readFileSync('e2e/.state/fixtures.json', 'utf8')) as { siteKey: string; password: string };
export const as = (role: 'admin' | 'operator' | 'viewer') => ({ storageState: `e2e/.state/${role}.json` });

/** Каждый тест падает, если на странице была ошибка JavaScript или ответ сервера 5xx. */
export const test = base.extend<{ problems: string[] }>({
  problems: [async ({ page }, use) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`JS: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
    await use(problems);
    expect(problems, 'ошибки на странице').toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function openSection(page: Page, title: string) {
  await page.locator('.side-nav button', { hasText: title }).click();
  await expect(page.locator('.page-head h1')).toHaveText(title);
}

/** Депозит через API сайта и оплата на тестовой странице провайдера. */
export async function paidDeposit(page: Page, amount: number, player: string) {
  const { siteKey } = fixtures();
  const r = await page.request.post('/v1/deposits', {
    headers: { authorization: `Bearer ${siteKey}`, 'idempotency-key': `e2e-${player}-${Date.now()}` },
    data: { amount, currency: 'EUR', player: { id: player, country: 'MT', kyc: 'verified' } },
  });
  const d = await r.json();
  await page.request.post(`${d.paymentUrl}/success`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, data: '' });
  return d as { id: string; paymentUrl: string };
}
