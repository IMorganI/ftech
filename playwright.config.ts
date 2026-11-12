import { defineConfig, devices } from '@playwright/test';

/**
 * Автотесты борды в настоящем браузере. Запуск: npm run build && npm run test:e2e
 * Нужна PostgreSQL: E2E_DATABASE_URL (или TEST_DATABASE_URL) — схема в ней пересоздаётся.
 */
const PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,                 // одна база на все тесты
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ru-RU',
    timezoneId: 'Europe/Kyiv',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `http://127.0.0.1:${PORT}/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
});
