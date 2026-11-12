import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { InvalidWebhookError } from '../providers/types.js';
import { handleProviderWebhook, providerWebhookChallenge, type PaymentDeps } from '../payments/flow.js';

/**
 * Приём вебхуков от провайдеров: POST /v1/provider-webhooks/:accountId
 * Тело читаем как сырую строку — подпись считается именно от неё, байт в байт.
 */
export async function providerWebhookRoutes(app: FastifyInstance, deps: PaymentDeps & { webhookRateLimitPerMinute?: number }) {
  // Адрес открыт без ключа (защищён токеном и подписью) — ограничиваем частоту, чтобы мусорными запросами
  // нельзя было нагружать базу и раздувать журнал вебхуков. Провайдеры шлют намного реже.
  await app.register(rateLimit, {
    max: deps.webhookRateLimitPerMinute ?? 600, timeWindow: '1 minute', keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({ statusCode: 429, error: { code: 'rate_limited', message: 'Слишком много запросов' } }),
  });
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => done(null, body));

  app.post<{ Params: { accountId: string } }>('/v1/provider-webhooks/:accountId', async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.accountId);
    if (!id.success || typeof req.body !== 'string') return reply.code(400).send({ error: { code: 'bad_request', message: 'Неверный запрос' } });
    try {
      const result = await handleProviderWebhook(deps, id.data, req.headers, req.body, req.query as Record<string, unknown>, req.ip);
      return { received: true, result };
    } catch (err) {
      if (err instanceof InvalidWebhookError) {
        req.log.warn({ accountId: id.data, reason: err.message }, 'Отклонён вебхук провайдера');
        return reply.code(401).send({ error: { code: 'invalid_signature', message: 'Вебхук не прошёл проверку' } });
      }
      throw err;
    }
  });

  // Некоторые провайдеры (Viva) при настройке вебхука проверяют адрес GET-запросом.
  app.get<{ Params: { accountId: string } }>('/v1/provider-webhooks/:accountId', async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.accountId);
    if (!id.success) return reply.code(404).send();
    try {
      const body = await providerWebhookChallenge(deps, id.data, req.query as Record<string, unknown>, req.ip);
      return body === null ? reply.code(404).send() : body;
    } catch (err) {
      if (err instanceof InvalidWebhookError) return reply.code(401).send({ error: { code: 'invalid_token', message: 'Неверный адрес вебхука' } });
      throw err;
    }
  });
}
