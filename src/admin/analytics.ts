import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import { requireAdmin, audit, bigintReplacer, type AdminDeps } from './auth.js';

/*
 * Аналитика: те же депозиты и выплаты, разложенные по операторам, сайтам, аккаунтам или провайдерам,
 * за любой период, плюс выгрузки в CSV.
 *
 *  GET /admin/v1/analytics                 — сводка (JSON) для борды             (viewer)
 *  GET /admin/v1/analytics.csv             — та же сводка файлом                  (viewer)
 *  GET /admin/v1/export/transactions.csv   — все платежи за период построчно      (operator, пишется в журнал)
 *
 * CSV рассчитан на Excel и Google Таблицы с русской/украинской локалью: разделитель «;», дробная часть
 * через запятую, UTF-8 с BOM. ?decimal=dot — точка и запятая-разделитель для англоязычных программ.
 * Ячейки, начинающиеся с = + - @, экранируются, чтобы таблица не выполнила их как формулу.
 */

const MAX_EXPORT_ROWS = 100_000;
const MAX_DAYS = 366;

const TZ_ALIASES: Record<string, string[]> = {
  'Europe/Kyiv': ['Europe/Kiev'], 'Europe/Kiev': ['Europe/Kyiv'], 'Asia/Calcutta': ['Asia/Kolkata'], 'Asia/Kolkata': ['Asia/Calcutta'],
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const querySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'custom']).default('30d'),
  from: day.optional(),
  to: day.optional(),
  tz: z.string().regex(/^[A-Za-z0-9_+\-/]{1,64}$/).default('UTC'),
  groupBy: z.enum(['operator', 'site', 'account', 'provider']).default('operator'),
  operatorId: z.string().uuid().optional(),
  decimal: z.enum(['comma', 'dot']).default('comma'),
}).refine((q) => q.period !== 'custom' || (q.from && q.to && q.from <= q.to), { message: 'Для своего периода нужны from ≤ to (ГГГГ-ММ-ДД)' });

type Query = z.infer<typeof querySchema>;
export type GroupBy = Query['groupBy'];

export interface Range { from: Date; to: Date; tz: string; fromDay: string; toDay: string }

async function resolveTz(pool: Pool, tz: string): Promise<string> {
  const known = (await pool.query(`SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])`,
    [[tz, ...(TZ_ALIASES[tz] ?? [])]])).rows.map((r) => r.name as string);
  return known.includes(tz) ? tz : known[0] ?? 'UTC';
}

/** Границы периода в поясе зрителя: [начало первого дня, конец последнего дня или «сейчас»). */
export async function resolveRange(pool: Pool, q: Pick<Query, 'period' | 'from' | 'to' | 'tz'>): Promise<Range> {
  const tz = await resolveTz(pool, q.tz);
  const r = q.period === 'custom'
    ? (await pool.query(
        `SELECT ($1::date)::timestamp AT TIME ZONE $3 AS from, ($2::date + 1)::timestamp AT TIME ZONE $3 AS to,
                ($2::date - $1::date) + 1 AS days`, [q.from, q.to, tz])).rows[0]
    : (await pool.query(
        `SELECT (date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2 - 1)) AT TIME ZONE $1 AS from, now() AS to`,
        [tz, { today: 1, '7d': 7, '30d': 30 }[q.period]])).rows[0];
  if (r.days !== undefined && Number(r.days) > MAX_DAYS) throw new RangeError(`Период не больше ${MAX_DAYS} дней`);
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { from: r.from, to: r.to, tz, fromDay: fmt(r.from), toDay: fmt(new Date(r.to.getTime() - 1)) };
}

// Ключ и название группы. Для аккаунтов и провайдеров депозит относится к аккаунту, который его провёл
// (или последнему, через который пробовали); без аккаунта — «нет подходящего аккаунта».
const KEYS: Record<GroupBy, { key: string; label: string; extra: string }> = {
  operator: { key: 'o.id', label: 'o.name', extra: `''` },
  site: { key: 's.id', label: 's.name', extra: 'o.name' },
  account: { key: 'm.id', label: `coalesce(m.name, 'Нет подходящего аккаунта')`, extra: `coalesce(p.name, '')` },
  provider: { key: 'p.id', label: `coalesce(p.name, 'Нет подходящего аккаунта')`, extra: `''` },
};

export interface AnalyticsRow {
  key: string | null; label: string; extra: string; currency: string;
  deposits: number; succeeded: number; declined: number; pending: number;
  attempts: number; attemptsOk: number;
  volume: bigint; earned: bigint; providerCost: bigint; refunded: bigint;
  payouts: number; paidOut: bigint;
}

export async function analytics(pool: Pool, range: Range, groupBy: GroupBy, operatorId?: string) {
  const g = KEYS[groupBy];
  const params = [range.from, range.to, operatorId ?? null];
  const base = `
    FROM transactions t
    JOIN sites s ON s.id = t.site_id
    JOIN operators o ON o.id = s.operator_id
    LEFT JOIN merchant_accounts m ON m.id = t.merchant_account_id
    LEFT JOIN providers p ON p.id = m.provider_id
    WHERE t.created_at >= $1 AND t.created_at < $2 AND ($3::uuid IS NULL OR o.id = $3)`;

  const deposits = (await pool.query(
    `SELECT ${g.key}::text AS key, ${g.label} AS label, ${g.extra} AS extra, t.currency,
       count(*)::int AS deposits,
       count(*) FILTER (WHERE t.status = 'success')::int AS succeeded,
       count(*) FILTER (WHERE t.status = 'declined')::int AS declined,
       count(*) FILTER (WHERE t.status IN ('created', 'pending'))::int AS pending,
       coalesce(sum(t.amount) FILTER (WHERE t.status = 'success'), 0) AS volume,
       coalesce(sum(t.platform_fee) FILTER (WHERE t.status = 'success'), 0) AS earned,
       coalesce(sum(t.provider_fee) FILTER (WHERE t.status = 'success'), 0) AS provider_cost,
       coalesce(sum(t.refunded_amount) FILTER (WHERE t.status = 'success'), 0) AS refunded
     ${base} AND t.type = 'deposit'
     GROUP BY 1, 2, 3, 4`, params)).rows;

  // Попытки: для аккаунтов и провайдеров — по аккаунту каждой попытки, иначе по сайту/оператору платежа.
  const attemptJoin = groupBy === 'account' || groupBy === 'provider'
    ? base.replace('LEFT JOIN merchant_accounts m ON m.id = t.merchant_account_id',
        'JOIN transaction_attempts a ON a.transaction_id = t.id LEFT JOIN merchant_accounts m ON m.id = a.merchant_account_id')
    : base.replace('WHERE', 'JOIN transaction_attempts a ON a.transaction_id = t.id WHERE');
  const attempts = (await pool.query(
    `SELECT ${g.key}::text AS key, ${g.label} AS label, ${g.extra} AS extra, t.currency,
       count(*) FILTER (WHERE a.status IN ('success', 'declined'))::int AS attempts,
       count(*) FILTER (WHERE a.status = 'success')::int AS attempts_ok
     ${attemptJoin} AND t.type = 'deposit'
     GROUP BY 1, 2, 3, 4`, params)).rows;

  // Выплаты: по оператору/сайту — сами выплаты; по аккаунту/провайдеру — возвраты на карты через этот аккаунт.
  const payouts = groupBy === 'account' || groupBy === 'provider'
    ? (await pool.query(
        `SELECT ${g.key}::text AS key, ${g.label} AS label, ${g.extra} AS extra, t.currency,
           count(*)::int AS payouts, coalesce(sum(l.amount), 0) AS paid_out
         ${base.replace('LEFT JOIN merchant_accounts m ON m.id = t.merchant_account_id',
           'JOIN payout_legs l ON l.payout_id = t.id LEFT JOIN merchant_accounts m ON m.id = l.merchant_account_id')}
           AND t.type = 'payout' AND l.kind = 'refund' AND l.status = 'success'
         GROUP BY 1, 2, 3, 4`, params)).rows
    : (await pool.query(
        `SELECT ${g.key}::text AS key, ${g.label} AS label, ${g.extra} AS extra, t.currency,
           count(*) FILTER (WHERE t.status = 'success')::int AS payouts,
           coalesce(sum(t.amount) FILTER (WHERE t.status = 'success'), 0) AS paid_out
         ${base} AND t.type = 'payout'
         GROUP BY 1, 2, 3, 4`, params)).rows;

  const rows = new Map<string, AnalyticsRow>();
  const row = (r: { key: string | null; label: string; extra: string; currency: string }) => {
    const id = `${r.key ?? ''}|${r.currency.trim()}`;
    let x = rows.get(id);
    if (!x) {
      x = { key: r.key, label: r.label, extra: r.extra, currency: r.currency.trim(), deposits: 0, succeeded: 0, declined: 0, pending: 0,
        attempts: 0, attemptsOk: 0, volume: 0n, earned: 0n, providerCost: 0n, refunded: 0n, payouts: 0, paidOut: 0n };
      rows.set(id, x);
    }
    return x;
  };
  for (const r of deposits) Object.assign(row(r), {
    deposits: r.deposits, succeeded: r.succeeded, declined: r.declined, pending: r.pending,
    volume: BigInt(r.volume), earned: BigInt(r.earned), providerCost: BigInt(r.provider_cost), refunded: BigInt(r.refunded),
  });
  for (const r of attempts) Object.assign(row(r), { attempts: r.attempts, attemptsOk: r.attempts_ok });
  for (const r of payouts) Object.assign(row(r), { payouts: r.payouts, paidOut: BigInt(r.paid_out) });

  const list = [...rows.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency) || (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0) || b.deposits - a.deposits || a.label.localeCompare(b.label));

  // Итог по каждой валюте (разные валюты не складываем).
  const totals = new Map<string, AnalyticsRow>();
  for (const r of list) {
    const t = totals.get(r.currency) ?? { ...r, key: null, label: 'Итого', extra: '', deposits: 0, succeeded: 0, declined: 0, pending: 0,
      attempts: 0, attemptsOk: 0, volume: 0n, earned: 0n, providerCost: 0n, refunded: 0n, payouts: 0, paidOut: 0n };
    t.deposits += r.deposits; t.succeeded += r.succeeded; t.declined += r.declined; t.pending += r.pending;
    t.attempts += r.attempts; t.attemptsOk += r.attemptsOk; t.volume += r.volume; t.earned += r.earned;
    t.providerCost += r.providerCost; t.refunded += r.refunded; t.payouts += r.payouts; t.paidOut += r.paidOut;
    totals.set(r.currency, t);
  }
  return { rows: list, totals: [...totals.values()] };
}

// ---------- CSV ----------

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // защита от выполнения формул в Excel
  return /[;",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvMoney(minor: bigint, decimal: 'comma' | 'dot'): string {
  const neg = minor < 0n; const a = neg ? -minor : minor;
  return `${neg ? '-' : ''}${a / 100n}${decimal === 'comma' ? ',' : '.'}${(a % 100n).toString().padStart(2, '0')}`;
}

export function toCsv(header: string[], rows: unknown[][], decimal: 'comma' | 'dot'): string {
  const sep = decimal === 'comma' ? ';' : ',';
  // Числа и суммы формируем сами — их не экранируем, иначе минус превратится в текст.
  const cell = (v: unknown) => (typeof v === 'object' && v !== null && 'raw' in v) ? String((v as { raw: string }).raw) : csvCell(v);
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(sep)).join('\r\n') + '\r\n';
}

const pct = (a: number, b: number, decimal: 'comma' | 'dot') =>
  ({ raw: b ? (Math.round((a / b) * 1000) / 10).toFixed(1).replace('.', decimal === 'comma' ? ',' : '.') : '' });

const GROUP_TITLE: Record<GroupBy, [string, string]> = {
  operator: ['Оператор', ''], site: ['Сайт', 'Оператор'], account: ['Аккаунт', 'Провайдер'], provider: ['Провайдер', ''],
};

function analyticsCsv(data: Awaited<ReturnType<typeof analytics>>, groupBy: GroupBy, decimal: 'comma' | 'dot'): string {
  const [g1, g2] = GROUP_TITLE[groupBy];
  const payoutTitle = groupBy === 'account' || groupBy === 'provider' ? 'Возвращено на карты' : 'Выплачено игрокам';
  const header = [g1, ...(g2 ? [g2] : []), 'Валюта', 'Депозитов', 'Успешных', 'Отказов', 'В процессе', 'Конверсия, %',
    'Попыток', 'Одобрено попыток, %', 'Оборот', 'Средний депозит', 'Заработала платформа', 'Комиссия провайдера',
    'Возвращено из депозитов', 'Выплат', payoutTitle];
  const m = (v: bigint) => ({ raw: csvMoney(v, decimal) });
  const line = (r: AnalyticsRow) => [r.label, ...(g2 ? [r.extra] : []), r.currency, { raw: r.deposits }, { raw: r.succeeded },
    { raw: r.declined }, { raw: r.pending }, pct(r.succeeded, r.succeeded + r.declined, decimal), { raw: r.attempts },
    pct(r.attemptsOk, r.attempts, decimal), m(r.volume), r.succeeded ? m(r.volume / BigInt(r.succeeded)) : '',
    m(r.earned), m(r.providerCost), m(r.refunded), { raw: r.payouts }, m(r.paidOut)];
  return toCsv(header, [...data.rows.map(line), ...data.totals.map(line)], decimal);
}

// ---------- маршруты ----------

export async function analyticsRoutes(app: FastifyInstance, d: AdminDeps) {
  const { pool } = d;
  const viewer = { preHandler: requireAdmin(d, 'viewer') };
  const operator = { preHandler: requireAdmin(d, 'operator') };

  const parseQuery = async (q: unknown, reply: FastifyReply) => {
    const r = querySchema.safeParse(q);
    if (!r.success) {
      reply.code(400).send({ error: { code: 'invalid_request', message: r.error.issues[0]?.message ?? 'Ошибка в запросе' } });
      return null;
    }
    try { return { q: r.data, range: await resolveRange(pool, r.data) }; }
    catch (err) {
      if (err instanceof RangeError) { reply.code(400).send({ error: { code: 'invalid_request', message: err.message } }); return null; }
      throw err;
    }
  };
  const fileName = (kind: string, range: Range) => `ftech-${kind}-${range.fromDay}_${range.toDay}.csv`;
  const sendCsv = (reply: FastifyReply, name: string, body: string) => reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}"`)
    .send(body);

  app.get('/admin/v1/analytics', viewer, async (req, reply) => {
    const p = await parseQuery(req.query, reply); if (!p) return;
    const data = await analytics(pool, p.range, p.q.groupBy, p.q.operatorId);
    return JSON.parse(JSON.stringify({ groupBy: p.q.groupBy, period: p.q.period, tz: p.range.tz,
      from: p.range.from, to: p.range.to, fromDay: p.range.fromDay, toDay: p.range.toDay, ...data }, bigintReplacer));
  });

  app.get('/admin/v1/analytics.csv', viewer, async (req, reply) => {
    const p = await parseQuery(req.query, reply); if (!p) return;
    const data = await analytics(pool, p.range, p.q.groupBy, p.q.operatorId);
    return sendCsv(reply, fileName(`summary-${p.q.groupBy}`, p.range), analyticsCsv(data, p.q.groupBy, p.q.decimal));
  });

  // Построчная выгрузка содержит ID игроков, поэтому — с роли «оператор» и с записью в журнал.
  app.get('/admin/v1/export/transactions.csv', operator, async (req, reply) => {
    const p = await parseQuery(req.query, reply); if (!p) return;
    const { range, q } = p;
    const rows = (await pool.query(
      `SELECT t.id, to_char(t.created_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS created,
         t.type::text, t.status::text, o.name AS operator, s.name AS site, pl.external_id AS player, pl.country,
         t.amount, t.currency, t.platform_fee, t.provider_fee, t.refunded_amount, m.name AS account, p.name AS provider,
         (SELECT count(*) FROM transaction_attempts a WHERE a.transaction_id = t.id)::int AS attempts, t.decline_code
       FROM transactions t
       JOIN sites s ON s.id = t.site_id JOIN operators o ON o.id = s.operator_id JOIN players pl ON pl.id = t.player_id
       LEFT JOIN merchant_accounts m ON m.id = t.merchant_account_id LEFT JOIN providers p ON p.id = m.provider_id
       WHERE t.created_at >= $1 AND t.created_at < $2 AND ($3::uuid IS NULL OR o.id = $3)
       ORDER BY t.created_at LIMIT $5`, [range.from, range.to, q.operatorId ?? null, range.tz, MAX_EXPORT_ROWS + 1])).rows;
    if (rows.length > MAX_EXPORT_ROWS) {
      return reply.code(413).send({ error: { code: 'too_many_rows', message: `Больше ${MAX_EXPORT_ROWS} платежей — выбери период короче` } });
    }
    await audit(pool, { userId: req.admin!.userId, action: 'export.transactions', entity: 'transactions', ip: req.ip,
      after: { from: range.fromDay, to: range.toDay, tz: range.tz, operatorId: q.operatorId ?? null, rows: rows.length } });
    const m = (v: bigint | null) => (v === null ? '' : { raw: csvMoney(BigInt(v), q.decimal) });
    const TYPE: Record<string, string> = { deposit: 'депозит', payout: 'выплата' };
    const STATUS: Record<string, string> = { created: 'создан', pending: 'в процессе', success: 'успешно', declined: 'отказ', failed: 'ошибка' };
    const body = toCsv(
      ['ID платежа', `Дата (${range.tz})`, 'Тип', 'Статус', 'Оператор', 'Сайт', 'ID игрока', 'Страна', 'Сумма', 'Валюта',
       'Заработала платформа', 'Комиссия провайдера', 'Возвращено', 'Аккаунт', 'Провайдер', 'Попыток', 'Причина отказа'],
      rows.map((r) => [r.id, r.created, TYPE[r.type] ?? r.type, STATUS[r.status] ?? r.status, r.operator, r.site, r.player,
        r.country.trim(), m(r.amount), r.currency.trim(), m(r.platform_fee), m(r.provider_fee),
        r.type === 'deposit' ? m(r.refunded_amount) : '', r.account, r.provider, { raw: r.attempts }, r.decline_code]),
      q.decimal);
    return sendCsv(reply, fileName('transactions', range), body);
  });
}
