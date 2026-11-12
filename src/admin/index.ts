import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { authRoutes, type AdminDeps } from './auth.js';
import { adminApiRoutes } from './api.js';
import { connectionRoutes } from './connections.js';
import { analyticsRoutes } from './analytics.js';
import { insightRoutes } from './insight.js';
import { moneyControlRoutes } from './money-control.js';
import { capacityRoutes } from './capacity.js';
import type { ProviderRegistry } from '../providers/types.js';
import type { SecretStore } from '../secrets.js';

/** Всё, что под /admin: вход, сессии, API управления. */
export async function adminPlugin(app: FastifyInstance, d: AdminDeps & { providers?: ProviderRegistry; secrets?: SecretStore; webhookBaseUrl?: string }) {
  await app.register(cookie);
  // Лимит частоты только там, где он задан в маршруте (вход).
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429, error: { code: 'rate_limited', message: `Слишком много попыток, подождите ${Math.ceil(ctx.ttl / 1000)} с` },
    }),
  });

  // Защита от CSRF: изменяющие запросы только с JSON. Чужой сайт не может отправить JSON
  // на наш домен без CORS-разрешения, а мы его не даём. Плюс cookie с SameSite=Strict.
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return reply.code(415).send({ error: { code: 'json_required', message: 'Нужен Content-Type: application/json' } });
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  await app.register(authRoutes, d);
  await app.register(adminApiRoutes, d);
  await app.register(analyticsRoutes, d);
  await app.register(insightRoutes, d);
  await app.register(moneyControlRoutes, d);
  await app.register(capacityRoutes, d);
  if (d.providers && d.secrets) {
    await app.register(connectionRoutes, { ...d, providers: d.providers, secrets: d.secrets, webhookBaseUrl: d.webhookBaseUrl ?? 'http://localhost:3000' });
  }
}
