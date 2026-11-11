import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Интерфейс админки: статические файлы из public/admin, отдаются по /admin. */
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/admin');

const FILES: Record<string, [string, string]> = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/app.css': ['app.css', 'text/css; charset=utf-8'],
};

// Строгая политика: только свои скрипты и стили, никаких встраиваний в чужие сайты.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join('; ');

export async function boardRoutes(app: FastifyInstance) {
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  for (const [route, [file, type]] of Object.entries(FILES)) {
    app.get(route, async (_req, reply) => {
      const body = await readFile(path.join(DIR, file));
      return reply
        .type(type)
        .header('content-security-policy', CSP)
        .header('x-frame-options', 'DENY')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-cache')
        .send(body);
    });
  }
}
