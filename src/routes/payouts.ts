import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { siteAuth } from '../auth.js';
import { getTransaction, serializeTx, IdempotencyConflictError, type TransactionView } from '../routing/router.js';
import type { PaymentDeps } from '../payments/flow.js';
import { createPayout, executePayout, getPayoutLegs, UnknownPlayerError, DuplicateWithdrawalError } from '../payouts/payouts.js';

const money = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,17}$/)])
  .transform((v) => BigInt(v));

const payoutBody = z.object({
  amount: money,
  currency: z.string().regex(/^[A-Z]{3}$/, 'Код валюты ISO 4217, например EUR'),
  withdrawalId: z.string().min(1).max(128).regex(/^[\w.:\-]+$/, 'ID вывода в системе казино: буквы, цифры, _ . : -'),
  player: z.object({
    id: z.string().min(1).max(128),
    kyc: z.enum(['none', 'pending', 'verified', 'rejected']).optional(),
  }),
});
const idempotencyKey = z.string().min(8).max(128).regex(/^[\w.:-]+$/);

export async function payoutRoutes(app: FastifyInstance, deps: PaymentDeps) {
  const { pool } = deps;
  app.addHook('preHandler', siteAuth(pool));

  const view = async (tx: TransactionView) => {
    const legs = await getPayoutLegs(pool, tx.id);
    const sum = (k: string, st?: string) => legs.filter((l) => l.kind === k && (!st || l.status === st)).reduce((a, l) => a + BigInt(l.amount), 0n);
    return {
      ...serializeTx(tx),
      withdrawalId: tx.withdrawalId ?? null,
      // Сколько вернётся на карты игрока автоматически и сколько оператор выплачивает вручную.
      refundAmount: (sum('refund') - sum('refund', 'failed')).toString(),
      manualAmount: sum('manual').toString(),
      parts: legs.map((l) => ({ kind: l.kind, amount: BigInt(l.amount).toString(), status: l.status })),
    };
  };

  app.post('/v1/payouts', async (req, reply) => {
    const key = idempotencyKey.safeParse(req.headers['idempotency-key']);
    if (!key.success) {
      return reply.code(400).send({ error: { code: 'idempotency_key_required',
        message: 'Нужен заголовок Idempotency-Key: 8–128 символов (буквы, цифры, _ . : -)' } });
    }
    const body = payoutBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Ошибка в теле запроса',
        details: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    try {
      const { tx, replayed } = await createPayout(pool, {
        siteId: req.site!.siteId, operatorId: req.site!.operatorId, idempotencyKey: key.data,
        amount: body.data.amount, currency: body.data.currency, withdrawalId: body.data.withdrawalId,
        player: { externalId: body.data.player.id, kyc: body.data.player.kyc },
      });
      if (replayed) return reply.code(200).send(await view(tx));
      // Резервы зафиксированы — теперь, вне транзакции, отправляем возвраты провайдерам.
      const final = tx.status === 'pending' ? await executePayout(deps, tx.id) : tx;
      return reply.code(201).send(await view(final));
    } catch (err) {
      if (err instanceof IdempotencyConflictError) return reply.code(409).send({ error: { code: 'idempotency_conflict', message: err.message } });
      if (err instanceof DuplicateWithdrawalError) {
        return reply.code(409).send({ error: { code: 'duplicate_withdrawal', message: err.message, details: { payoutId: err.payoutId } } });
      }
      if (err instanceof UnknownPlayerError) return reply.code(422).send({ error: { code: 'unknown_player', message: err.message } });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/payouts/:id', async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id);
    const tx = id.success ? await getTransaction(pool, req.site!.siteId, id.data) : null;
    if (!tx || tx.type !== 'payout') return reply.code(404).send({ error: { code: 'not_found', message: 'Выплата не найдена' } });
    return view(tx);
  });
}
