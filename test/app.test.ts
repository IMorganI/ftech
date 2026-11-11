import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('HTTP', () => {
  it('/health отвечает ok без базы', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/ready без базы — 503', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
  });
});

describe('Конфигурация', () => {
  it('падает с понятной ошибкой без DATABASE_URL и ENCRYPTION_KEY', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('подставляет значения по умолчанию', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', ENCRYPTION_KEY: 'k' });
    expect(c.PORT).toBe(3000);
    expect(c.LOG_LEVEL).toBe('info');
    expect(c.MOCK_PROVIDER_ENABLED).toBe(false);
  });
});
