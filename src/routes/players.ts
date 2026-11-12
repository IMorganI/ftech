import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { siteAuth } from '../auth.js';
import { withTransaction } from '../db/tx.js';
import type { PaymentDeps } from '../payments/flow.js';
import { applyDuePending, applyRestrictions, lockPlayer, serializeRestrictions } from '../players/restrictions.js';

/**
 * Ограничения игрока (ответственная игра) — отдельно от депозитов:
 *   GET /v1/players/:id/restrictions — что действует сейчас и что вступит в силу позже;
 *   PUT /v1/players/:id/restrictions — изменить (с проверкой версии, если передана).
 * :id — ID игрока на стороне сайта.
 */
const money = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,17}$/)])
  .transform((v) => BigInt(v));
const playerId = z.string().min(1).max(128);

const body = z.object({
  version: z.number().int().positive().optional(),
  selfExcluded: z.boolean().optional(),
  kyc: z.enum(['none', 'pending', 'verified', 'rejected']).optional(),
  depositLimitDaily: money.nullable().optional(),
  note: z.string().max(500).optional(),
}).strict();

export async function playerRoutes(app: FastifyInstance, deps: PaymentDeps) {
  const { pool } = deps;
  app.addHook('preHandler', siteAuth(pool));
  const notFound = { error: { code: 'not_found', message: 'Игрок не найден — он появляется после первого депозита' } };

  app.get<{ Params: { id: string } }>('/v1/players/:id/restrictions', async (req, reply) => {
    const id = playerId.safeParse(req.params.id);
    if (!id.success) return reply.code(404).send(notFound);
    return withTransaction(pool, async (c) => {
      const row = (await c.query(`SELECT id FROM players WHERE site_id = $1 AND external_id = $2`, [req.site!.siteId, id.data])).rows[0];
      if (!row) return reply.code(404).send(notFound);
      return serializeRestrictions(await applyDuePending(c, await lockPlayer(c, row.id)));
    });
  });

  app.put<{ Params: { id: string } }>('/v1/players/:id/restrictions', async (req, reply) => {
    const id = playerId.safeParse(req.params.id);
    if (!id.success) return reply.code(404).send(notFound);
    const b = body.safeParse(req.body);
    if (!b.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Ошибка в теле запроса',
        details: b.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    return withTransaction(pool, async (c) => {
      const row = (await c.query(
        `SELECT p.id, o.limit_increase_delay_hours AS delay FROM players p JOIN sites s ON s.id = p.site_id JOIN operators o ON o.id = s.operator_id
         WHERE p.site_id = $1 AND p.external_id = $2`, [req.site!.siteId, id.data])).rows[0];
      if (!row) return reply.code(404).send(notFound);
      const player = await lockPlayer(c, row.id);
      if (b.data.version !== undefined && b.data.version !== player.restrictions_version) {
        return reply.code(409).send({ error: { code: 'version_conflict',
          message: `Ограничения уже изменились (версия ${player.restrictions_version}) — перечитай их и повтори`, details: serializeRestrictions(player) } });
      }
      const next = await applyRestrictions(c, player, b.data, 'api', { increaseDelayHours: row.delay, note: b.data.note });
      return serializeRestrictions(next);
    });
  });
}
