import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import { requireAdmin, bigintReplacer, type AdminDeps } from './auth.js';

/*
 * Ёмкость: сколько ещё можно принять сегодня по каждой валюте (с учётом порога переключения),
 * как быстро уходит лимит (темп за последний час) и когда он закончится при таком темпе.
 * Резервный уровень показывается отдельно: он включается, когда основные заполнены.
 */

const pct = (a: bigint, b: bigint) => (b > 0n ? Number((a * 100n) / b) : 0);

export interface CapacityAccount {
  id: string; name: string; provider: string; operatorId: string; tier: 'primary' | 'reserve'; weight: number; priority: number; feeBps: number;
  limit: bigint; used: bigint; reserved: bigint; taken: bigint; free: bigint; fillPct: number;
  /** Доля сегодняшнего оборота среди аккаунтов того же уровня и валюты, % — и целевая по весам, %. */
  sharePct: number; targetPct: number;
  monthlyCap: bigint | null; monthTaken: bigint;
}
interface Totals { limit: bigint; taken: bigint; free: bigint }

export async function capacity(pool: Pool) {
  const rows = (await pool.query(
    `SELECT m.id, m.name, p.name AS provider, m.operator_id, m.tier, m.weight, m.priority, m.fee_bps, m.currencies[1] AS currency,
            (m.daily_cap * m.switch_at_bps / 10000) AS lim, m.monthly_cap,
            coalesce(u.used, 0) AS used, coalesce(u.reserved, 0) AS reserved,
            (SELECT coalesce(sum(x.used + x.reserved), 0) FROM account_usage x WHERE x.merchant_account_id = m.id AND x.currency = m.currencies[1]
               AND x.day >= date_trunc('month', (now() AT TIME ZONE m.cap_timezone))::date) AS month_taken,
            extract(epoch FROM (date_trunc('day', now() AT TIME ZONE m.cap_timezone) + interval '1 day') - (now() AT TIME ZONE m.cap_timezone))::int / 60 AS reset_in_min
     FROM merchant_accounts m JOIN providers p ON p.id = m.provider_id
     LEFT JOIN account_usage u ON u.merchant_account_id = m.id AND u.currency = m.currencies[1]
       AND u.day = (now() AT TIME ZONE m.cap_timezone)::date
     WHERE m.enabled ORDER BY m.currencies[1], m.tier, m.priority DESC, m.name`)).rows;

  const rate = new Map<string, bigint>();
  for (const r of (await pool.query(
    `SELECT t.currency, sum(t.amount)::bigint AS s FROM transactions t
     WHERE t.type = 'deposit' AND t.status IN ('pending', 'success') AND t.merchant_account_id IS NOT NULL
       AND t.created_at > now() - interval '1 hour' GROUP BY t.currency`)).rows) rate.set(r.currency.trim(), BigInt(r.s));

  const byCur = new Map<string, typeof rows>();
  for (const r of rows) byCur.set(r.currency.trim(), [...(byCur.get(r.currency.trim()) ?? []), r]);

  const currencies = [...byCur].map(([currency, list]) => {
    const tiers: Record<'primary' | 'reserve', Totals> = { primary: { limit: 0n, taken: 0n, free: 0n }, reserve: { limit: 0n, taken: 0n, free: 0n } };
    const accounts: CapacityAccount[] = list.map((r) => {
      const limit = BigInt(r.lim); const used = BigInt(r.used); const reserved = BigInt(r.reserved);
      const taken = used + reserved; const free = limit > taken ? limit - taken : 0n;
      const t = tiers[r.tier as 'primary' | 'reserve'];
      t.limit += limit; t.taken += taken; t.free += free;
      return { id: r.id, name: r.name, provider: r.provider, operatorId: r.operator_id, tier: r.tier, weight: r.weight, priority: r.priority,
        feeBps: r.fee_bps, limit, used, reserved, taken, free, fillPct: pct(taken, limit), sharePct: 0, targetPct: 0,
        monthlyCap: r.monthly_cap === null ? null : BigInt(r.monthly_cap), monthTaken: BigInt(r.month_taken) };
    });
    // Доли — внутри оператора и уровня (веса сравниваются только между «соседями»).
    for (const a of accounts) {
      const peers = accounts.filter((x) => x.operatorId === a.operatorId && x.tier === a.tier);
      const w = peers.reduce((s, x) => s + x.weight, 0);
      const tk = peers.reduce((s, x) => s + x.taken, 0n);
      a.targetPct = w ? Math.round((a.weight / w) * 100) : 0;
      a.sharePct = pct(a.taken, tk);
    }
    const limit = tiers.primary.limit + tiers.reserve.limit;
    const taken = tiers.primary.taken + tiers.reserve.taken;
    const free = tiers.primary.free + tiers.reserve.free;
    const perHour = rate.get(currency) ?? 0n;
    return {
      currency, limit, taken, free, fillPct: pct(taken, limit), tiers, accounts,
      ratePerHour: perHour,
      exhaustInMin: perHour > 0n ? Number((free * 60n) / perHour) : null,
      resetInMin: Math.min(...list.map((r) => Number(r.reset_in_min))),
    };
  });

  const operators = (await pool.query(`SELECT id, name, routing_mode FROM operators ORDER BY name`)).rows;
  return { currencies, operators };
}

export async function capacityRoutes(app: FastifyInstance, d: AdminDeps) {
  app.get('/admin/v1/capacity', { preHandler: requireAdmin(d, 'viewer') }, async () =>
    JSON.parse(JSON.stringify(await capacity(d.pool), bigintReplacer)));
}
