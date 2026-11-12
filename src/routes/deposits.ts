import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { siteAuth } from '../auth.js';
import { routeDeposit, getTransaction, serializeTx, IdempotencyConflictError } from '../routing/router.js';
import { submitPending, type PaymentDeps } from '../payments/flow.js';

// Суммы — целые числа в минорных единицах (центы). Принимаем число или строку из цифр.
const money = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,17}$/)])
  .transform((v) => BigInt(v));

const depositBody = z.object({
  amount: money,
  currency: z.string().regex(/^[A-Z]{3}$/, 'Код валюты ISO 4217, например EUR'),
  returnUrl: z.string().url().max(2000).refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'),
    'Только https://').nullable().default(null),
  player: z.object({
    id: z.string().min(1).max(128),
    country: z.string().regex(/^[A-Z]{2}$/, 'Код страны ISO 3166-1, например MT'),
    // Необязательные. Из депозита ограничения можно только ужесточить; снять — PUT /v1/players/:id/restrictions.
    kyc: z.enum(['none', 'pending', 'verified', 'rejected']).optional(),
    depositLimitDaily: money.nullable().optional(),
    selfExcluded: z.boolean().optional(),
  }),
});

const idempotencyKey = z.string().min(8).max(128).regex(/^[\w.:-]+$/);

export async function depositRoutes(app: FastifyInstance, deps: PaymentDeps) {
  const { pool } = deps;
  app.addHook('preHandler', siteAuth(pool));

  app.post('/v1/deposits', async (req, reply) => {
    const key = idempotencyKey.safeParse(req.headers['idempotency-key']);
    if (!key.success) {
      return reply.code(400).send({ error: { code: 'idempotency_key_required',
        message: 'Нужен заголовок Idempotency-Key: 8–128 символов (буквы, цифры, _ . : -)' } });
    }
    const body = depositBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Ошибка в теле запроса',
        details: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    const b = body.data;
    try {
      const { tx, replayed } = await routeDeposit(pool, {
        siteId: req.site!.siteId, operatorId: req.site!.operatorId, idempotencyKey: key.data,
        amount: b.amount, currency: b.currency, returnUrl: b.returnUrl,
        player: { externalId: b.player.id, country: b.player.country, kyc: b.player.kyc,
          depositLimitDaily: b.player.depositLimitDaily, selfExcluded: b.player.selfExcluded },
      });
      if (replayed) {
        return reply.code(200).send(serializeTx((await getTransaction(pool, req.site!.siteId, tx.id)) ?? tx));
      }
      // Резерв уже закоммичен — теперь, вне транзакции, отправляем платёж провайдеру.
      const final = tx.status === 'pending' ? await submitPending(deps, tx.id) : tx;
      return reply.code(201).send(serializeTx(final));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.code(409).send({ error: { code: 'idempotency_conflict', message: err.message } });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/deposits/:id', async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const tx = id.success ? await getTransaction(pool, req.site!.siteId, id.data) : null;
    if (!tx || tx.type !== 'deposit') return reply.code(404).send({ error: { code: 'not_found', message: 'Платёж не найден' } });
    return serializeTx(tx);
  });
}
