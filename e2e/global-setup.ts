import { request, type FullConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { totpAt, totpStep } from '../dist/admin/security.js';

/** Вход каждой ролью через API (пароль + 2FA) и сохранение сессии — тесты открывают борду уже авторизованными. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!;
  const { password } = JSON.parse(readFileSync('e2e/.state/fixtures.json', 'utf8'));
  for (const role of ['admin', 'operator', 'viewer']) {
    const ctx = await request.newContext({ baseURL });
    const r1 = await ctx.post('/admin/v1/auth/login', { data: { email: `${role}@e2e.test`, password } });
    if (!r1.ok()) throw new Error(`Вход ${role}: HTTP ${r1.status()}`);
    const { totpSecret } = await r1.json();
    const r2 = await ctx.post('/admin/v1/auth/totp', { data: { code: totpAt(totpSecret, totpStep()) } });
    if (!r2.ok()) throw new Error(`2FA ${role}: HTTP ${r2.status()}`);
    await ctx.storageState({ path: `e2e/.state/${role}.json` });
    await ctx.dispose();
  }
}
