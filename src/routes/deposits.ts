import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import { siteAuth } from '../auth.js';
import { routeDeposit, getTransaction, IdempotencyConflictError, type TransactionView } from '../routing/router.js';

// Суммы — целые числа в минорных единицах (центы). Принимаем число или строку из цифр.
const money = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,17}$/)])
  .transform((v) => BigInt(v));

const depositBody = z.object({
  amount: money,
  currency: z.string().regex(/^[A-Z]{3}$/, 'Код валюты ISO 4217, например EUR'),
  player: z.object({
    id: z.string().min(1).max(128),
    country: z.string().regex(/^[A-Z]{2}$/, 'Код страны ISO 3166-1, например MT'),
    kyc: z.enum(['none', 'pending', 'verified', 'rejected']).default('none'),
    depositLimitDaily: money.nullable().default(null),
    selfExcluded: z.boolean().default(false),
  }),
});

const idempotencyKey = z.string().min(8).max(128).regex(/^[\w.:-]+$/);

export function serializeTx(tx: TransactionView) {
  return {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    amount: tx.amount.toString(),
    currency: tx.currency,
    declineCode: tx.declineCode,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
  };
}

export async function depositRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;
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
        amount: b.amount, currency: b.currency,
        player: { externalId: b.player.id, country: b.player.country, kyc: b.player.kyc,
          depositLimitDaily: b.player.depositLimitDaily, selfExcluded: b.player.selfExcluded },
      });
      return reply.code(replayed ? 200 : 201).send(serializeTx(tx));
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
    if (!tx) return reply.code(404).send({ error: { code: 'not_found', message: 'Платёж не найден' } });
    return serializeTx(tx);
  });
}
