import { test, expect, as, openSection } from './fixtures';

const ALL = ['Обзор', 'Аналитика', 'Платежи', 'Ручные выплаты', 'Операторы и аккаунты', 'Лимиты и маршрутизация', 'Тест-платёж',
  'Зависшие деньги', 'Проблемы', 'Чарджбэки', 'Сверка с провайдером'];
const ADMIN_ONLY = ['Журнал действий', 'Команда'];

for (const role of ['admin', 'operator', 'viewer'] as const) {
  test.describe(`роль: ${role}`, () => {
    test.use(as(role));

    test('каждый раздел открывается без ошибок', async ({ page }) => {
      await page.goto('/admin');
      const sections = role === 'admin' ? [...ALL, ...ADMIN_ONLY] : ALL;
      await expect(page.locator('.side-nav button')).toHaveCount(sections.length);
      for (const title of sections) {
        await openSection(page, title);
        await expect(page.locator('#main')).not.toBeEmpty();
        await expect(page.locator('#main .msg.err'), `ошибка в разделе «${title}»`).toHaveCount(0);
      }
    });
  });
}

test.describe('права', () => {
  test.use(as('viewer'));
  test('наблюдатель не видит кнопок изменения', async ({ page }) => {
    await page.goto('/admin');
    await openSection(page, 'Лимиты и маршрутизация');
    await expect(page.locator('.acc').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Лимиты', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'По весам' })).toHaveCount(0);
    // запрос в обход интерфейса тоже отклоняется
    const r = await page.request.patch('/admin/v1/operators/00000000-0000-0000-0000-000000000000', { data: { routingMode: 'weights' } });
    expect(r.status()).toBe(403);
  });
});

test.describe('телефон', () => {
  test.use({ ...as('admin'), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('нет горизонтальной прокрутки, меню открывается кнопкой', async ({ page }) => {
    await page.goto('/admin');
    for (const title of ['Обзор', 'Платежи', 'Лимиты и маршрутизация', 'Сверка с провайдером']) {
      await page.getByRole('button', { name: 'Меню' }).click();
      await openSection(page, title);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `ширина «${title}»`).toBeLessThanOrEqual(0);
    }
  });
});
