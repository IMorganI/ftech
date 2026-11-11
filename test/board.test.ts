import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Pool } from '../src/db/pool.js';

// Раздача интерфейса не трогает базу, поэтому хватает заглушки пула.
const app = buildApp({ pool: {} as Pool, admin: { encryptionKey: Buffer.alloc(32), secureCookies: true } });

describe('Борда', () => {
  it('отдаёт страницу, скрипт и стили со строгой политикой безопасности', async () => {
    for (const [url, type] of [['/admin', 'text/html'], ['/admin/app.js', 'text/javascript'], ['/admin/app.css', 'text/css']]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain(type);
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('интерфейс не использует innerHTML и внешние ресурсы', async () => {
    const js = (await app.inject({ method: 'GET', url: '/admin/app.js' })).body;
    const html = (await app.inject({ method: 'GET', url: '/admin' })).body;
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
