import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from './db/pool.js';
import { depositRoutes } from './routes/deposits.js';

export interface AppDeps {
  pool?: Pool;
  logLevel?: string;
  /** Запросов в минуту на один API-ключ (или IP без ключа). */
  rateLimitPerMinute?: number;
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: deps.logLevel
      ? { level: deps.logLevel, redact: ['req.headers.authorization'] } // ключи сайтов никогда не попадают в логи
      : false,
    bodyLimit: 64 * 1024,
  });

  // Жив ли процесс (для балансировщика).
  app.get('/health', async () => ({ status: 'ok' }));

  // Готов ли принимать платежи: есть связь с базой.
  app.get('/ready', async (_req, reply) => {
    if (!deps.pool) return reply.code(503).send({ status: 'no_database' });
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'database_unavailable' });
    }
  });

  const pool = deps.pool;
  if (pool) {
    app.register(async (api) => {
      await api.register(rateLimit, {
        max: deps.rateLimitPerMinute ?? 600,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.headers.authorization ?? req.ip,
        errorResponseBuilder: (_req, ctx) => ({
          statusCode: 429,
          error: { code: 'rate_limited', message: `Слишком много запросов, повторите через ${Math.ceil(ctx.ttl / 1000)} с` },
        }),
      });
      await api.register(depositRoutes, { pool });
    });
  }

  // Внутренние ошибки не раскрываем наружу.
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error(err);
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Внутренняя ошибка, попробуйте позже' } });
    }
    return reply.code(status).send(
      (err as { error?: unknown }).error ? err : { error: { code: 'bad_request', message: (err as Error).message } },
    );
  });

  return app;
}
