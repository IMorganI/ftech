import { test, expect, fixtures } from './fixtures';
import { totpAt, totpStep } from '../dist/admin/security.js';

test('первый вход: пароль → QR и ключ 2FA → код → смена временного пароля → борда', async ({ page }) => {
  const { password } = fixtures();
  await page.goto('/admin');
  await page.locator('#login-email').fill('fresh@e2e.test');
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Продолжить' }).click();

  await expect(page.locator('h1')).toHaveText('Настройка 2FA');
  await expect(page.locator('img.qr')).toBeVisible();
  const secret = (await page.locator('.secret').textContent())!.trim();
  await page.locator('#totp-code').fill(totpAt(secret, totpStep()));
  await page.getByRole('button', { name: 'Подтвердить' }).click();

  await expect(page.locator('h1')).toHaveText('Смена временного пароля');
  await page.locator('input[name=currentPassword]').fill(password);
  await page.locator('input[name=newPassword]').fill('new e2e password 2027');
  await page.getByRole('button', { name: 'Сменить пароль' }).click();

  await expect(page.locator('.page-head h1')).toHaveText('Обзор');
  await expect(page.locator('.side-foot .me')).toContainText('fresh@e2e.test');

  // выход возвращает на экран входа, сессия больше не работает
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.locator('h1')).toHaveText('Вход');
  expect((await page.request.get('/admin/v1/me')).status()).toBe(401);
});

test('неверный пароль — понятная ошибка, без входа', async ({ page }) => {
  await page.goto('/admin');
  await page.locator('#login-email').fill('viewer@e2e.test');
  await page.locator('#login-password').fill('wrong password 1');
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.locator('.msg.err')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('Вход');
});
