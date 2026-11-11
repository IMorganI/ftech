import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from './db/pool.js';

export interface AppDeps {
  pool?: Pool;
  logLevel?: string;
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logLevel ? { level: deps.logLevel } : false });

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

  return app;
}
