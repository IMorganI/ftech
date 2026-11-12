import { test, expect, as, fixtures, openSection, paidDeposit } from './fixtures';

test.describe('деньги', () => {
  test.use(as('operator'));

  test('тест-платёж: создать депозит, оплатить, увидеть историю платежа', async ({ page, context }) => {
    await page.goto('/admin');
    await openSection(page, 'Тест-платёж');
    const form = page.locator('form').first();
    await form.locator('input[name=key]').fill(fixtures().siteKey);
    await form.locator('input[name=amount]').fill('42.50');
    await form.locator('input[name=player]').fill('e2e-sandbox');
    await form.getByRole('button', { name: 'Создать депозит' }).click();
    const link = page.getByRole('link', { name: /Открыть страницу оплаты/ });
    await expect(link).toBeVisible();

    // страница оплаты провайдера открывается в новой вкладке
    const [pay] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await pay.getByRole('button', { name: 'Оплатить' }).click();
    await expect(pay.getByRole('button', { name: 'Оплатить' })).toHaveCount(0); // после оплаты кнопок больше нет
    await pay.close();
    await page.bringToFront();

    await openSection(page, 'Платежи');
    const row = page.locator('tr.click', { hasText: 'e2e-sandbox' });
    await expect(row.locator('.pill')).toHaveText(/успех/i, { timeout: 15_000 });
    await row.click();
    const detail = page.locator('#tx-detail');
    await expect(detail.locator('.tx-amount')).toContainText('42.50');
    await expect(detail.locator('.timeline li')).not.toHaveCount(0);
    await expect(detail).toContainText('Заработок платформы');
  });

  test('выплата больше депозитов: возврат на карту + ручной остаток, отметка с номером перевода', async ({ page }) => {
    await paidDeposit(page, 5000, 'e2e-payout');
    const { siteKey } = fixtures();
    const po = await page.request.post('/v1/payouts', {
      headers: { authorization: `Bearer ${siteKey}`, 'idempotency-key': `e2e-po-${Date.now()}` },
      data: { amount: 8000, currency: 'EUR', withdrawalId: `W-E2E-${Date.now()}`, player: { id: 'e2e-payout' } },
    });
    expect(po.ok()).toBeTruthy();
    const body = await po.json();
    expect([body.refundAmount, body.manualAmount]).toEqual(['5000', '3000']); // суммы — строки (BIGINT)

    await page.goto('/admin');
    await openSection(page, 'Ручные выплаты');
    const row = page.locator('tr', { hasText: 'e2e-payout' });
    await expect(row).toContainText('30.00 EUR');
    await row.locator('input[name=reference]').fill('SEPA-E2E-1');
    await row.getByRole('button', { name: 'Выплачено' }).click();
    await expect(page.locator('tr', { hasText: 'e2e-payout' })).toHaveCount(0);

    await page.getByLabel('Показать выполненные').check();
    await expect(page.locator('tr', { hasText: 'e2e-payout' })).toContainText('SEPA-E2E-1');
  });
});

test.describe('лимиты', () => {
  test.use(as('admin'));

  test('переключение режима распределения и изменение лимита аккаунта', async ({ page }) => {
    await page.goto('/admin');
    await openSection(page, 'Лимиты и маршрутизация');
    await expect(page.locator('.cap, .capacity, section.panel').first()).toBeVisible();

    await page.getByRole('button', { name: 'По весам' }).click();
    await expect(page.getByRole('button', { name: 'По весам' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.acc').first()).toContainText('Вес');
    await page.getByRole('button', { name: 'По порядку' }).click();
    await expect(page.getByRole('button', { name: 'По порядку' })).toHaveAttribute('aria-pressed', 'true');

    const card = page.locator('.acc', { hasText: 'Тест · EUR' });
    await card.getByRole('button', { name: 'Лимиты' }).click();
    await card.locator('input[name=dailyCap]').fill('2500');
    await card.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.locator('.acc', { hasText: 'Тест · EUR' })).toContainText('из 2 500.00 EUR');
  });

  test('сумма больше свободного лимита — отказ с суммой, которую можно принять', async ({ page }) => {
    const { siteKey } = fixtures();
    const acc = (await (await page.request.get('/admin/v1/accounts')).json()).find((a: { name: string }) => a.name === 'Тест · EUR');
    expect((await page.request.patch(`/admin/v1/accounts/${acc.id}`, { data: { dailyCap: 250000 } })).ok()).toBeTruthy();
    const r = await page.request.post('/v1/deposits', {
      headers: { authorization: `Bearer ${siteKey}`, 'idempotency-key': `e2e-cap-${Date.now()}` },
      data: { amount: 900000, currency: 'EUR', player: { id: 'e2e-cap', country: 'MT', kyc: 'verified' } },
    });
    const d = await r.json();
    expect(d.status).toBe('declined');
    expect(d.declineCode).toBe('capacity_exhausted');
    expect(Number(d.declineDetails.maxAmountNow)).toBeGreaterThan(0);
  });
});
