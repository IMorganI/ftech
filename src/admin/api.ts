import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, isUniqueViolation } from '../db/tx.js';
import { generateApiKey } from '../auth.js';
import { encrypt, randomSecret } from '../crypto.js';
import { requireAdmin, audit, bigintReplacer, type AdminDeps } from './auth.js';
import { hashPassword, temporaryPassword } from './security.js';
import { completeManualLeg, approveManualLeg, ManualLegError } from '../payouts/payouts.js';

/*
 * API админки: /admin/v1/*
 *  viewer   — только чтение
 *  operator — плюс оперативные действия: вкл/выкл аккаунтов, лимиты, приоритет, разбор расхождений
 *  admin    — всё: операторы, сайты и их ключи, провайдеры, создание аккаунтов, пользователи, журнал аудита
 * Каждое изменение пишется в audit_log с состоянием «до» и «после». Секреты в журнал не попадают.
 */

const money = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,17}$/)])
  .transform((v) => BigInt(v));
const uuid = z.string().uuid();
const currency = z.string().regex(/^[A-Z]{3}$/);
const country = z.string().regex(/^[A-Z]{2}$/);
const httpsUrl = z.string().url().max(2000).refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), 'Только https://');

/** bigint → строка, чтобы JSON не терял точность сумм. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v, bigintReplacer));

const fail = (reply: FastifyReply, status: number, code: string, message: string, details?: unknown) =>
  reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, reply: FastifyReply): z.infer<T> | null {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  fail(reply, 400, 'invalid_request', 'Ошибка в запросе', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return null;
}

export async function adminApiRoutes(app: FastifyInstance, d: AdminDeps) {
  const { pool } = d;
  const viewer = { preHandler: requireAdmin(d, 'viewer') };
  const operator = { preHandler: requireAdmin(d, 'operator') };
  const admin = { preHandler: requireAdmin(d, 'admin') };
  const who = (req: FastifyRequest) => ({ userId: req.admin!.userId, ip: req.ip });

  // ---------- сводка для борды ----------

  app.get('/admin/v1/overview', viewer, async () => {
    const r = (await pool.query(`
      SELECT
        (SELECT count(*) FROM transactions WHERE created_at > now() - interval '24 hours')::int AS tx_24h,
        (SELECT count(*) FROM transactions WHERE created_at > now() - interval '24 hours' AND status = 'success')::int AS success_24h,
        (SELECT count(*) FROM transactions WHERE status = 'pending')::int AS pending,
        (SELECT count(*) FROM reconciliation_issues WHERE NOT resolved)::int AS open_issues,
        (SELECT count(*) FROM webhook_deliveries WHERE status = 'failed')::int AS failed_webhooks,
        (SELECT count(*) FROM payout_legs WHERE kind = 'manual' AND status = 'pending')::int AS manual_payouts,
        (SELECT coalesce(json_object_agg(currency, total), '{}') FROM (
           SELECT currency, sum(amount)::text AS total FROM transactions
           WHERE status = 'success' AND created_at > now() - interval '24 hours' GROUP BY currency) v) AS volume_24h`)).rows[0];
    return r;
  });

  // ---------- статистика для «Обзора» ----------
  // Период считается в часовом поясе того, кто смотрит: «сегодня» в Киеве и в UTC — разные сутки.

  app.get('/admin/v1/stats', viewer, async (req, reply) => {
    const q = parse(z.object({
      period: z.enum(['today', '7d', '30d']).default('7d'),
      tz: z.string().regex(/^[A-Za-z0-9_+\-/]{1,64}$/).default('UTC'),
    }), req.query, reply);
    if (!q) return;
    const days = { today: 1, '7d': 7, '30d': 30 }[q.period];
    // Названия поясов меняются (Europe/Kiev → Europe/Kyiv), а база может знать только одно из них.
    const ALIASES: Record<string, string[]> = { 'Europe/Kyiv': ['Europe/Kiev'], 'Europe/Kiev': ['Europe/Kyiv'], 'Asia/Calcutta': ['Asia/Kolkata'], 'Asia/Kolkata': ['Asia/Calcutta'] };
    const known = (await pool.query(`SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])`,
      [[q.tz, ...(ALIASES[q.tz] ?? [])]])).rows.map((r) => r.name as string);
    const tz = known.includes(q.tz) ? q.tz : known[0] ?? 'UTC';
    const unit = q.period === 'today' ? 'hour' : 'day';
    return withTransaction(pool, async (c) => {
        // Начало периода в часовом поясе зрителя, переведённое в абсолютное время.
        const from = (await c.query(
          `SELECT (date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2 - 1)) AT TIME ZONE $1 AS from`,
          [tz, days])).rows[0].from;

        const totals = (await c.query(
          `SELECT currency,
             count(*)::int AS attempts,
             count(*) FILTER (WHERE status = 'success')::int AS succeeded,
             count(*) FILTER (WHERE status = 'declined')::int AS declined,
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             coalesce(sum(amount) FILTER (WHERE status = 'success'), 0) AS volume,
             coalesce(sum(platform_fee) FILTER (WHERE status = 'success'), 0) AS earned,
             coalesce(sum(provider_fee) FILTER (WHERE status = 'success'), 0) AS provider_cost
           FROM transactions WHERE type = 'deposit' AND created_at >= $1
           GROUP BY currency ORDER BY volume DESC`, [from])).rows;

        const series = (await c.query(
          `WITH b AS (
             SELECT generate_series(date_trunc($3, $1::timestamptz AT TIME ZONE $2), date_trunc($3, now() AT TIME ZONE $2),
                                    CASE WHEN $3 = 'hour' THEN interval '1 hour' ELSE interval '1 day' END) AS bucket),
           counts AS (
             SELECT date_trunc($3, created_at AT TIME ZONE $2) AS bucket,
               count(*) FILTER (WHERE status = 'success')::int AS succeeded,
               count(*) FILTER (WHERE status = 'declined')::int AS declined
             FROM transactions WHERE type = 'deposit' AND created_at >= $1 GROUP BY 1),
           vol AS (
             SELECT bucket, json_object_agg(currency, total) AS volume FROM (
               SELECT date_trunc($3, created_at AT TIME ZONE $2) AS bucket, currency, sum(amount)::text AS total
               FROM transactions WHERE type = 'deposit' AND status = 'success' AND created_at >= $1 GROUP BY 1, 2) v
             GROUP BY bucket)
           SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
             coalesce(c.succeeded, 0) AS succeeded, coalesce(c.declined, 0) AS declined, coalesce(v.volume, '{}') AS volume
           FROM b LEFT JOIN counts c USING (bucket) LEFT JOIN vol v USING (bucket)
           ORDER BY b.bucket`, [from, tz, unit])).rows;

        const bySite = (await c.query(
          `SELECT s.name AS site, t.currency,
             count(*) FILTER (WHERE t.status = 'success')::int AS succeeded,
             count(*)::int AS attempts,
             coalesce(sum(t.amount) FILTER (WHERE t.status = 'success'), 0) AS volume,
             coalesce(sum(t.platform_fee) FILTER (WHERE t.status = 'success'), 0) AS earned
           FROM transactions t JOIN sites s ON s.id = t.site_id
           WHERE t.type = 'deposit' AND t.created_at >= $1
           GROUP BY s.name, t.currency ORDER BY volume DESC`, [from])).rows;

        const recent = (await c.query(
          `SELECT t.id, t.status, t.amount, t.currency, t.decline_code, t.created_at, s.name AS site, p.external_id AS player
           FROM transactions t JOIN sites s ON s.id = t.site_id JOIN players p ON p.id = t.player_id
           WHERE t.type = 'deposit' ORDER BY t.created_at DESC LIMIT 8`)).rows;

        const payouts = (await c.query(
          `SELECT currency, count(*) FILTER (WHERE status = 'success')::int AS succeeded,
             count(*) FILTER (WHERE status = 'pending')::int AS pending,
             coalesce(sum(amount) FILTER (WHERE status = 'success'), 0) AS paid_out
           FROM transactions WHERE type = 'payout' AND created_at >= $1 GROUP BY currency`, [from])).rows;

        const fees = (await c.query(`SELECT min(platform_fee_bps) AS min, max(platform_fee_bps) AS max FROM operators`)).rows[0];

        return plain({ period: q.period, unit, tz, from, totals, payouts, series, bySite, recent, platformFeeBps: fees });
    });
  });

  // ---------- операторы ----------

  app.get('/admin/v1/operators', viewer, async () =>
    plain((await pool.query(`SELECT id, name, licenses, kyc_required_above, max_attempts, platform_fee_bps, payout_kyc_required, payout_max_amount, manual_approval_above, limit_increase_delay_hours, routing_mode, created_at FROM operators ORDER BY name`)).rows));

  const operatorBody = z.object({
    name: z.string().min(1).max(200),
    licenses: z.array(country).max(250),
    kycRequiredAbove: money.nullable(),
    maxAttempts: z.number().int().min(1).max(10),
    platformFeeBps: z.number().int().min(0).max(10000),
    payoutMaxAmount: money.nullable(),
    manualApprovalAbove: z.union([z.literal(0), money]).nullable().transform((v) => (v === 0 ? 0n : v)),
    limitIncreaseDelayHours: z.number().int().min(0).max(720),
    routingMode: z.enum(['fill', 'weights']),
  });

  app.post('/admin/v1/operators', admin, async (req, reply) => {
    const b = parse(operatorBody.partial({ kycRequiredAbove: true, maxAttempts: true, platformFeeBps: true, payoutMaxAmount: true, manualApprovalAbove: true, limitIncreaseDelayHours: true, routingMode: true }), req.body, reply);
    if (!b) return;
    const row = (await pool.query(
      `INSERT INTO operators (name, licenses, kyc_required_above, max_attempts, platform_fee_bps) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [b.name, b.licenses, b.kycRequiredAbove ?? null, b.maxAttempts ?? 3, b.platformFeeBps ?? 0])).rows[0];
    await audit(pool, { ...who(req), action: 'operator.create', entity: 'operator', entityId: row.id, after: row });
    return reply.code(201).send(plain(row));
  });

  app.patch<{ Params: { id: string } }>('/admin/v1/operators/:id', admin, async (req, reply) => {
    const b = parse(operatorBody.partial(), req.body, reply);
    if (!b) return;
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return fail(reply, 404, 'not_found', 'Оператор не найден');
    return withTransaction(pool, async (c) => {
      const before = (await c.query(`SELECT * FROM operators WHERE id = $1 FOR UPDATE`, [id.data])).rows[0];
      if (!before) return fail(reply, 404, 'not_found', 'Оператор не найден');
      const after = (await c.query(
        `UPDATE operators SET name = coalesce($2, name), licenses = coalesce($3, licenses),
           kyc_required_above = CASE WHEN $4::boolean THEN $5 ELSE kyc_required_above END,
           max_attempts = coalesce($6, max_attempts), platform_fee_bps = coalesce($7, platform_fee_bps),
           payout_max_amount = CASE WHEN $8::boolean THEN $9 ELSE payout_max_amount END,
           manual_approval_above = CASE WHEN $10::boolean THEN $11 ELSE manual_approval_above END,
           limit_increase_delay_hours = coalesce($12, limit_increase_delay_hours), routing_mode = coalesce($13, routing_mode) WHERE id = $1 RETURNING *`,
        [id.data, b.name ?? null, b.licenses ?? null, b.kycRequiredAbove !== undefined, b.kycRequiredAbove ?? null, b.maxAttempts ?? null, b.platformFeeBps ?? null,
         b.payoutMaxAmount !== undefined, b.payoutMaxAmount ?? null, b.manualApprovalAbove !== undefined, b.manualApprovalAbove ?? null,
         b.limitIncreaseDelayHours ?? null, b.routingMode ?? null])).rows[0];
      await audit(c, { ...who(req), action: 'operator.update', entity: 'operator', entityId: id.data, before, after });
      return plain(after);
    });
  });

  // ---------- сайты и их ключи ----------

  const SITE_COLUMNS = `id, operator_id, name, webhook_url, enabled, created_at, (webhook_secret_enc IS NOT NULL) AS has_webhook_secret`;

  app.get('/admin/v1/sites', viewer, async () =>
    (await pool.query(`SELECT ${SITE_COLUMNS} FROM sites ORDER BY created_at`)).rows);

  app.post('/admin/v1/sites', admin, async (req, reply) => {
    const b = parse(z.object({ operatorId: uuid, name: z.string().min(1).max(200), webhookUrl: httpsUrl.nullable().default(null) }), req.body, reply);
    if (!b) return;
    const key = generateApiKey();
    const webhookSecret = randomSecret('whsec_');
    try {
      const row = (await pool.query(
        `INSERT INTO sites (operator_id, name, api_key_hash, webhook_url, webhook_secret_enc) VALUES ($1, $2, $3, $4, $5) RETURNING ${SITE_COLUMNS}`,
        [b.operatorId, b.name, key.hash, b.webhookUrl, encrypt(d.encryptionKey, webhookSecret)])).rows[0];
      await audit(pool, { ...who(req), action: 'site.create', entity: 'site', entityId: row.id, after: row });
      // Ключ и секрет показываются только здесь, один раз.
      return reply.code(201).send({ ...row, apiKey: key.key, webhookSecret });
    } catch (err) {
      if ((err as { code?: string }).code === '23503') return fail(reply, 400, 'invalid_request', 'Оператор не найден');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/admin/v1/sites/:id', admin, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Сайт не найден');
    const b = parse(z.object({ name: z.string().min(1).max(200), webhookUrl: httpsUrl.nullable(), enabled: z.boolean() }).partial(), req.body, reply);
    if (!b) return;
    return withTransaction(pool, async (c) => {
      const before = (await c.query(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!before) return fail(reply, 404, 'not_found', 'Сайт не найден');
      const after = (await c.query(
        `UPDATE sites SET name = coalesce($2, name), webhook_url = CASE WHEN $3::boolean THEN $4 ELSE webhook_url END,
           enabled = coalesce($5, enabled) WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
        [req.params.id, b.name ?? null, b.webhookUrl !== undefined, b.webhookUrl ?? null, b.enabled ?? null])).rows[0];
      await audit(c, { ...who(req), action: 'site.update', entity: 'site', entityId: req.params.id, before, after });
      return after;
    });
  });

  // Перевыпуск ключа: старый перестаёт работать сразу.
  app.post<{ Params: { id: string } }>('/admin/v1/sites/:id/rotate-key', admin, async (req, reply) => {
    const key = generateApiKey();
    const r = await pool.query(`UPDATE sites SET api_key_hash = $2 WHERE id = $1 RETURNING id`, [req.params.id, key.hash]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return fail(reply, 404, 'not_found', 'Сайт не найден');
    await audit(pool, { ...who(req), action: 'site.rotate_key', entity: 'site', entityId: req.params.id });
    return { apiKey: key.key };
  });

  app.post<{ Params: { id: string } }>('/admin/v1/sites/:id/rotate-webhook-secret', admin, async (req, reply) => {
    const secret = randomSecret('whsec_');
    const r = await pool.query(`UPDATE sites SET webhook_secret_enc = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, encrypt(d.encryptionKey, secret)]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return fail(reply, 404, 'not_found', 'Сайт не найден');
    await audit(pool, { ...who(req), action: 'site.rotate_webhook_secret', entity: 'site', entityId: req.params.id });
    return { webhookSecret: secret };
  });

  // ---------- провайдеры ----------

  app.get('/admin/v1/providers', viewer, async () =>
    (await pool.query(`SELECT id, code, name, adapter, created_at FROM providers ORDER BY name`)).rows);

  app.post('/admin/v1/providers', admin, async (req, reply) => {
    const b = parse(z.object({ code: z.string().regex(/^[a-z0-9_-]{2,40}$/), name: z.string().min(1).max(200), adapter: z.string().regex(/^[a-z0-9_-]{2,40}$/) }), req.body, reply);
    if (!b) return;
    try {
      const row = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ($1, $2, $3) RETURNING *`, [b.code, b.name, b.adapter])).rows[0];
      await audit(pool, { ...who(req), action: 'provider.create', entity: 'provider', entityId: row.id, after: row });
      return reply.code(201).send(row);
    } catch (err) {
      if (isUniqueViolation(err)) return fail(reply, 409, 'conflict', 'Провайдер с таким code уже есть');
      throw err;
    }
  });

  // ---------- мерчант-аккаунты ----------

  const ACCOUNT_SELECT = `
    SELECT m.id, m.operator_id, m.provider_id, p.code AS provider_code, m.name, m.currencies, m.countries,
           m.min_amount, m.max_amount, m.daily_cap, m.monthly_cap, m.switch_at_bps, m.fee_bps, m.priority, m.tier, m.weight,
           m.cap_timezone, m.credentials_ref, m.enabled, m.created_at,
           coalesce(u.used, 0) AS used_today, coalesce(u.reserved, 0) AS reserved_today
    FROM merchant_accounts m JOIN providers p ON p.id = m.provider_id
    LEFT JOIN account_usage u ON u.merchant_account_id = m.id AND u.day = (now() AT TIME ZONE m.cap_timezone)::date AND u.currency = m.currencies[1]`;

  app.get('/admin/v1/accounts', viewer, async () =>
    plain((await pool.query(`${ACCOUNT_SELECT} ORDER BY m.priority DESC, m.fee_bps, m.name`)).rows));

  // Оперативные поля (operator+) и структурные (только admin).
  const opFields = z.object({
    enabled: z.boolean(), dailyCap: money, monthlyCap: money.nullable(),
    switchAtBps: z.number().int().min(1).max(10000), feeBps: z.number().int().min(0).max(10000), priority: z.number().int().min(-1000).max(1000),
    tier: z.enum(['primary', 'reserve']), weight: z.number().int().min(1).max(10000),
  });
  const adminFields = z.object({
    name: z.string().min(1).max(200), currencies: z.array(currency).length(1, 'Одна валюта на аккаунт: лимиты считаются в ней'), countries: z.array(country).min(1).max(250),
    minAmount: money, maxAmount: money, capTimezone: z.string().min(1).max(64), credentialsRef: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).nullable(),
  });

  app.post('/admin/v1/accounts', admin, async (req, reply) => {
    const b = parse(opFields.partial({ enabled: true, monthlyCap: true, switchAtBps: true, feeBps: true, priority: true, tier: true, weight: true })
      .merge(adminFields.partial({ capTimezone: true, credentialsRef: true }))
      .extend({ operatorId: uuid, providerId: uuid }), req.body, reply);
    if (!b) return;
    try {
      const row = (await pool.query(
        `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap,
           monthly_cap, switch_at_bps, fee_bps, priority, cap_timezone, credentials_ref, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, 9500), coalesce($11, 0), coalesce($12, 0), coalesce($13, 'UTC'), $14, coalesce($15, true))
         RETURNING id`,
        [b.operatorId, b.providerId, b.name, b.currencies, b.countries, b.minAmount, b.maxAmount, b.dailyCap, b.monthlyCap ?? null,
         b.switchAtBps ?? null, b.feeBps ?? null, b.priority ?? null, b.capTimezone ?? null, b.credentialsRef ?? null, b.enabled ?? null])).rows[0];
      const after = (await pool.query(`${ACCOUNT_SELECT} WHERE m.id = $1`, [row.id])).rows[0];
      await audit(pool, { ...who(req), action: 'account.create', entity: 'account', entityId: row.id, after });
      return reply.code(201).send(plain(after));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23503') return fail(reply, 400, 'invalid_request', 'Оператор или провайдер не найден');
      if (code === '23514') return fail(reply, 400, 'invalid_request', 'Лимиты не согласованы (max ≥ min, месячный ≥ дневного)');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/admin/v1/accounts/:id', operator, async (req, reply) => {
    const b = parse(opFields.merge(adminFields).partial().strict(), req.body, reply);
    if (!b) return;
    const structural = Object.keys(adminFields.shape).filter((k) => k in b);
    if (structural.length && req.admin!.role !== 'admin') {
      return fail(reply, 403, 'forbidden', `Менять ${structural.join(', ')} может только admin`);
    }
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    try {
      return await withTransaction(pool, async (c) => {
        const before = (await c.query(`${ACCOUNT_SELECT} WHERE m.id = $1 FOR UPDATE OF m`, [id.data])).rows[0];
        if (!before) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
        if (b.enabled === true && !before.enabled) {
          const keys = (await c.query(
            `SELECT m.credentials_enc IS NOT NULL OR m.credentials_ref IS NOT NULL OR $2::text IS NOT NULL AS ok FROM merchant_accounts m WHERE m.id = $1`,
            [id.data, b.credentialsRef ?? null])).rows[0];
          if (!keys.ok) return fail(reply, 409, 'no_credentials', 'Сначала введи ключи провайдера в разделе «Подключения»');
        }
        await c.query(
          `UPDATE merchant_accounts SET
             enabled = coalesce($2, enabled), daily_cap = coalesce($3, daily_cap),
             monthly_cap = CASE WHEN $4::boolean THEN $5 ELSE monthly_cap END,
             switch_at_bps = coalesce($6, switch_at_bps), fee_bps = coalesce($7, fee_bps), priority = coalesce($8, priority),
             name = coalesce($9, name), currencies = coalesce($10, currencies), countries = coalesce($11, countries),
             min_amount = coalesce($12, min_amount), max_amount = coalesce($13, max_amount), cap_timezone = coalesce($14, cap_timezone),
             credentials_ref = CASE WHEN $15::boolean THEN $16 ELSE credentials_ref END,
             tier = coalesce($17, tier), weight = coalesce($18, weight)
           WHERE id = $1`,
          [id.data, b.enabled ?? null, b.dailyCap ?? null, b.monthlyCap !== undefined, b.monthlyCap ?? null,
           b.switchAtBps ?? null, b.feeBps ?? null, b.priority ?? null, b.name ?? null, b.currencies ?? null, b.countries ?? null,
           b.minAmount ?? null, b.maxAmount ?? null, b.capTimezone ?? null, b.credentialsRef !== undefined, b.credentialsRef ?? null,
           b.tier ?? null, b.weight ?? null]);
        const after = (await c.query(`${ACCOUNT_SELECT} WHERE m.id = $1`, [id.data])).rows[0];
        await audit(c, { ...who(req), action: 'account.update', entity: 'account', entityId: id.data, before, after });
        return plain(after);
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23514') return fail(reply, 400, 'invalid_request', 'Лимиты не согласованы (max ≥ min, месячный ≥ дневного)');
      throw err;
    }
  });

  // ---------- платежи ----------

  app.get('/admin/v1/transactions', viewer, async (req, reply) => {
    const q = parse(z.object({
      status: z.enum(['created', 'pending', 'success', 'declined', 'failed']).optional(),
      type: z.enum(['deposit', 'payout']).optional(),
      siteId: uuid.optional(), accountId: uuid.optional(), player: z.string().max(128).optional(),
      before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query, reply);
    if (!q) return;
    const rows = (await pool.query(
      `SELECT t.id, t.type, t.status, t.amount, t.currency, t.decline_code, t.created_at, t.updated_at,
              s.name AS site, p.external_id AS player, p.country, m.name AS account,
              (SELECT count(*) FROM transaction_attempts a WHERE a.transaction_id = t.id)::int
                + (SELECT count(*) FROM payout_legs l WHERE l.payout_id = t.id)::int AS attempts
       FROM transactions t JOIN sites s ON s.id = t.site_id JOIN players p ON p.id = t.player_id
       LEFT JOIN merchant_accounts m ON m.id = t.merchant_account_id
       WHERE ($1::tx_status IS NULL OR t.status = $1) AND ($2::uuid IS NULL OR t.site_id = $2)
         AND ($3::uuid IS NULL OR t.merchant_account_id = $3) AND ($4::text IS NULL OR p.external_id = $4)
         AND ($5::timestamptz IS NULL OR t.created_at < $5) AND ($7::tx_type IS NULL OR t.type = $7)
       ORDER BY t.created_at DESC LIMIT $6`,
      [q.status ?? null, q.siteId ?? null, q.accountId ?? null, q.player ?? null, q.before ?? null, q.limit, q.type ?? null])).rows;
    return plain(rows);
  });

  app.get<{ Params: { id: string } }>('/admin/v1/transactions/:id', viewer, async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const tx = id.success ? (await pool.query(
      `SELECT t.*, s.name AS site, p.external_id AS player, p.country FROM transactions t
       JOIN sites s ON s.id = t.site_id JOIN players p ON p.id = t.player_id WHERE t.id = $1`, [id.data])).rows[0] : null;
    if (!tx) return fail(reply, 404, 'not_found', 'Платёж не найден');
    delete tx.request_hash;
    const attempts = (await pool.query(
      `SELECT a.attempt_no, a.status, a.provider_ref, a.route_reason, a.error, a.created_at, a.submitted_at, m.name AS account
       FROM transaction_attempts a JOIN merchant_accounts m ON m.id = a.merchant_account_id
       WHERE a.transaction_id = $1 ORDER BY a.attempt_no`, [id.data])).rows;
    const ledger = (await pool.query(`SELECT account, amount, currency, created_at FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`, [id.data])).rows;
    const legs = (await pool.query(
      `SELECT l.id, l.kind, l.amount, l.status, l.error, l.note, l.provider_ref, l.completed_at, m.name AS account, u.email AS completed_by
       FROM payout_legs l LEFT JOIN merchant_accounts m ON m.id = l.merchant_account_id LEFT JOIN admin_users u ON u.id = l.completed_by
       WHERE l.payout_id = $1 ORDER BY l.kind, l.created_at`, [id.data])).rows;
    const webhooks = (await pool.query(
      `SELECT event, status, attempts, last_error, created_at, delivered_at FROM webhook_deliveries WHERE transaction_id = $1 ORDER BY id`, [id.data])).rows;
    return plain({ ...tx, attempts, legs, ledger, webhooks });
  });

  // ---------- ручные выплаты ----------

  app.get('/admin/v1/manual-payouts', viewer, async (req) => {
    const all = (req.query as { all?: string }).all === 'true';
    return plain((await pool.query(
      `SELECT l.id, l.amount, l.status, l.note, l.reference, l.created_at, l.completed_at, u.email AS completed_by,
              l.approved_at, l.approved_by AS approved_by_id, ua.email AS approved_by,
              (o.manual_approval_above IS NOT NULL AND l.amount >= o.manual_approval_above) AS needs_approval,
              t.id AS payout_id, t.withdrawal_id, t.currency, t.amount AS payout_amount, s.name AS site, p.external_id AS player, p.country
       FROM payout_legs l JOIN transactions t ON t.id = l.payout_id JOIN sites s ON s.id = t.site_id JOIN operators o ON o.id = s.operator_id
       JOIN players p ON p.id = t.player_id LEFT JOIN admin_users u ON u.id = l.completed_by LEFT JOIN admin_users ua ON ua.id = l.approved_by
       WHERE l.kind = 'manual' AND ($1 OR l.status = 'pending')
       ORDER BY l.created_at DESC LIMIT 200`, [all])).rows);
  });

  const manualError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ManualLegError) return fail(reply, err.code === 'not_found' ? 404 : 409, err.code, err.message);
    throw err;
  };

  app.post<{ Params: { id: string } }>('/admin/v1/manual-payouts/:id/approve', operator, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Ручная выплата не найдена');
    try { await approveManualLeg(pool, req.params.id, who(req)); return { ok: true }; } catch (err) { return manualError(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/admin/v1/manual-payouts/:id/complete', operator, async (req, reply) => {
    const b = parse(z.object({
      reference: z.string().trim().min(3, 'Укажи номер перевода или платёжного поручения').max(200),
      note: z.string().trim().max(500).default(''),
    }), req.body, reply);
    if (!b) return;
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Ручная выплата не найдена');
    try {
      const tx = await completeManualLeg(pool, req.params.id, who(req), { reference: b.reference, note: b.note });
      return { ok: true, payoutStatus: tx.status };
    } catch (err) { return manualError(reply, err); }
  });

  app.get('/admin/v1/issues', viewer, async (req) => {
    const all = (req.query as { all?: string }).all === 'true';
    return plain((await pool.query(
      `SELECT i.*, u.email AS resolved_by_email FROM reconciliation_issues i LEFT JOIN admin_users u ON u.id = i.resolved_by
       WHERE $1 OR NOT i.resolved ORDER BY i.created_at DESC LIMIT 200`, [all])).rows);
  });

  app.post<{ Params: { id: string } }>('/admin/v1/issues/:id/resolve', operator, async (req, reply) => {
    const b = parse(z.object({ note: z.string().min(3).max(2000) }), req.body, reply);
    if (!b) return;
    const row = (await pool.query(
      `UPDATE reconciliation_issues SET resolved = true, resolved_by = $2, resolved_at = now(), resolution_note = $3
       WHERE id = $1 AND NOT resolved RETURNING *`, [Number(req.params.id) || 0, req.admin!.userId, b.note])).rows[0];
    if (!row) return fail(reply, 404, 'not_found', 'Открытое расхождение не найдено');
    await audit(pool, { ...who(req), action: 'issue.resolve', entity: 'issue', entityId: String(row.id), after: { note: b.note } });
    return plain(row);
  });

  // ---------- пользователи админки ----------

  const USER_COLUMNS = `id, email, role, totp_enabled, must_change_password, disabled, last_login_at, created_at,
                        (locked_until IS NOT NULL AND locked_until > now()) AS locked`;

  app.get('/admin/v1/users', admin, async () => (await pool.query(`SELECT ${USER_COLUMNS} FROM admin_users ORDER BY email`)).rows);

  app.post('/admin/v1/users', admin, async (req, reply) => {
    const b = parse(z.object({ email: z.string().email().max(254), role: z.enum(['viewer', 'operator', 'admin']) }), req.body, reply);
    if (!b) return;
    const temp = temporaryPassword();
    try {
      const row = (await pool.query(
        `INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
        [b.email.toLowerCase(), await hashPassword(temp), b.role])).rows[0];
      await audit(pool, { ...who(req), action: 'user.create', entity: 'user', entityId: row.id, after: row });
      return reply.code(201).send({ ...row, temporaryPassword: temp });
    } catch (err) {
      if (isUniqueViolation(err)) return fail(reply, 409, 'conflict', 'Пользователь с таким email уже есть');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/admin/v1/users/:id', admin, async (req, reply) => {
    const b = parse(z.object({ role: z.enum(['viewer', 'operator', 'admin']), disabled: z.boolean() }).partial(), req.body, reply);
    if (!b) return;
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Пользователь не найден');
    if (req.params.id === req.admin!.userId) return fail(reply, 400, 'invalid_request', 'Нельзя менять роль или блокировать самого себя');
    return withTransaction(pool, async (c) => {
      const before = (await c.query(`SELECT ${USER_COLUMNS} FROM admin_users WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!before) return fail(reply, 404, 'not_found', 'Пользователь не найден');
      const after = (await c.query(
        `UPDATE admin_users SET role = coalesce($2, role), disabled = coalesce($3, disabled) WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [req.params.id, b.role ?? null, b.disabled ?? null])).rows[0];
      if (b.disabled || (b.role && b.role !== before.role)) {
        await c.query(`UPDATE admin_sessions SET revoked = true WHERE user_id = $1`, [req.params.id]);
      }
      await audit(c, { ...who(req), action: 'user.update', entity: 'user', entityId: req.params.id, before, after });
      return after;
    });
  });

  // Потерял телефон: 2FA сбрасывается, при следующем входе настраивается заново.
  app.post<{ Params: { id: string } }>('/admin/v1/users/:id/reset-2fa', admin, async (req, reply) => {
    const r = await pool.query(
      `UPDATE admin_users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = $1 RETURNING id`,
      [req.params.id]).catch(() => ({ rows: [] }));
    if (!r.rows[0]) return fail(reply, 404, 'not_found', 'Пользователь не найден');
    await pool.query(`UPDATE admin_sessions SET revoked = true WHERE user_id = $1`, [req.params.id]);
    await audit(pool, { ...who(req), action: 'user.reset_2fa', entity: 'user', entityId: req.params.id });
    return { ok: true };
  });

  // ---------- журнал аудита ----------

  app.get('/admin/v1/audit', admin, async (req, reply) => {
    const q = parse(z.object({
      entity: z.string().max(40).optional(), entityId: z.string().max(64).optional(),
      beforeId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
    }), req.query, reply);
    if (!q) return;
    return plain((await pool.query(
      `SELECT l.id, l.action, l.entity, l.entity_id, l.before, l.after, l.ip, l.created_at, u.email AS user_email
       FROM audit_log l LEFT JOIN admin_users u ON u.id = l.admin_user_id
       WHERE ($1::text IS NULL OR l.entity = $1) AND ($2::text IS NULL OR l.entity_id = $2) AND ($3::bigint IS NULL OR l.id < $3)
       ORDER BY l.id DESC LIMIT $4`,
      [q.entity ?? null, q.entityId ?? null, q.beforeId ?? null, q.limit])).rows);
  });
}
