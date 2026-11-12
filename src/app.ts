import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from './db/pool.js';
import type { SecretStore } from './secrets.js';
import type { ProviderRegistry } from './providers/types.js';
import type { MockProvider } from './providers/mock.js';
import type { TestPaySimulator } from './providers/testpay.js';
import { testPayRoutes } from './routes/testpay.js';
import { depositRoutes } from './routes/deposits.js';
import { payoutRoutes } from './routes/payouts.js';
import { providerWebhookRoutes } from './routes/provider-webhooks.js';
import { playerRoutes } from './routes/players.js';
import { mockProviderRoutes } from './routes/mock-provider.js';
import { adminPlugin } from './admin/index.js';
import { boardRoutes } from './admin/board.js';

export interface AppDeps {
  pool?: Pool;
  providers?: ProviderRegistry;
  secrets?: SecretStore;
  /** Мок-провайдер со страницей оплаты — только для разработки и тестов. */
  mock?: MockProvider;
  /** Учебный провайдер TestPay (кабинет и страница оплаты), только в разработке. */
  testpay?: TestPaySimulator;
  logLevel?: string;
  /** Запросов в минуту на один API-ключ (или IP без ключа). */
  rateLimitPerMinute?: number;
  /** Частота запросов на адрес вебхуков провайдеров с одного IP, в минуту (по умолчанию 600). */
  webhookRateLimitPerMinute?: number;
  /** Админка: ключ шифрования секретов и флаг HTTPS-cookie. */
  admin?: { encryptionKey: Buffer; secureCookies: boolean; loginRateLimitPerMinute?: number; webhookBaseUrl?: string };
  trustProxy?: boolean;
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: deps.logLevel
      ? {
          level: deps.logLevel,
          redact: ['req.headers.authorization'], // ключи сайтов никогда не попадают в логи
          serializers: {
            // Секретный токен из адреса вебхука провайдера тоже не пишем в логи.
            req: (r: { method: string; url: string; ip?: string }) => ({ method: r.method, url: r.url.replace(/token=[^&]*/g, 'token=***'), ip: r.ip }),
          },
        }
      : false,
    bodyLimit: 64 * 1024,
    trustProxy: deps.trustProxy ?? false,
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

  const { pool, providers, secrets } = deps;
  if (pool && providers && secrets) {
    const payment = { pool, providers, secrets, encryptionKey: deps.admin?.encryptionKey };

    // API для сайтов: авторизация по ключу + ограничение частоты.
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
      await api.register(depositRoutes, payment);
      await api.register(payoutRoutes, payment);
      await api.register(playerRoutes, payment);
    });

    // Вебхуки провайдеров: без ключа сайта, защищены подписью провайдера.
    app.register(providerWebhookRoutes, { ...payment, webhookRateLimitPerMinute: deps.webhookRateLimitPerMinute });

    if (deps.mock) app.register(mockProviderRoutes, { mock: deps.mock });
    if (deps.testpay) app.register(testPayRoutes, { sim: deps.testpay });
  }

  if (pool && deps.admin) {
    // Корень сайта ведёт в борду: удобно открывать адрес без /admin.
    app.get('/', async (_req, reply) => reply.redirect('/admin', 302));
    app.register(adminPlugin, { pool, ...deps.admin, providers, secrets });
    app.register(boardRoutes);
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
