import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdmin, bigintReplacer, audit, type AdminDeps } from './auth.js';
import { ChargebackError, openChargeback, updateChargeback } from '../chargebacks/chargebacks.js';
import { autoMapping, FIELDS, FIELD_TITLES, normalizeRows, parseCsv, type Mapping } from '../reports/csv.js';
import { importReport } from '../reports/reconcile.js';

/*
 * Контроль денег: чарджбэки и сверка по выпискам провайдера.
 *   GET  /admin/v1/chargebacks?all=true          список (viewer)
 *   POST /admin/v1/chargebacks                    завести вручную (operator)
 *   POST /admin/v1/chargebacks/:id/status         сменить статус (operator)
 *   POST /admin/v1/reports/preview                разобрать CSV и предложить сопоставление колонок (operator)
 *   POST /admin/v1/reports/import                 загрузить и сверить (operator)
 *   GET  /admin/v1/reports, /admin/v1/reports/:id история загрузок и результат (viewer)
 *   POST /admin/v1/reports/lines/:id/resolve      отметить расхождение разобранным (operator)
 */

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v, bigintReplacer));
const uuid = z.string().uuid();
const money = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,17}$/)]).transform((v) => BigInt(v));
const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });
const MAX_CSV = 5 * 1024 * 1024;

export async function moneyControlRoutes(app: FastifyInstance, d: AdminDeps) {
  const { pool } = d;
  const viewer = { preHandler: requireAdmin(d, 'viewer') };
  const operator = { preHandler: requireAdmin(d, 'operator') };
  const who = (req: { admin?: { userId: string }; ip: string }) => ({ userId: req.admin!.userId, ip: req.ip });
  const cbError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ChargebackError) return fail(reply, err.code === 'not_found' ? 404 : 409, err.code, err.message);
    throw err;
  };

  // ---------- чарджбэки ----------

  app.get('/admin/v1/chargebacks', viewer, async (req) => {
    const all = (req.query as { all?: string }).all === 'true';
    return plain((await pool.query(
      `SELECT cb.id, cb.transaction_id, cb.case_ref, cb.reason_code, cb.reason, cb.amount, cb.currency, cb.fee, cb.status,
              cb.respond_by, cb.source, cb.opened_at, cb.resolved_at, m.name AS account, s.name AS site, p.external_id AS player,
              t.amount AS deposit_amount, (cb.respond_by - (now() AT TIME ZONE 'UTC')::date) AS days_left,
              (SELECT json_agg(json_build_object('status', e.status, 'note', e.note, 'at', e.created_at, 'by', u.email) ORDER BY e.id)
                 FROM chargeback_events e LEFT JOIN admin_users u ON u.id = e.admin_user_id WHERE e.chargeback_id = cb.id) AS history
       FROM chargebacks cb JOIN transactions t ON t.id = cb.transaction_id JOIN sites s ON s.id = t.site_id
       JOIN players p ON p.id = t.player_id JOIN merchant_accounts m ON m.id = cb.merchant_account_id
       WHERE $1 OR cb.status IN ('open', 'evidence_submitted')
       ORDER BY (cb.status IN ('open', 'evidence_submitted')) DESC, cb.respond_by NULLS LAST, cb.opened_at DESC LIMIT 300`, [all])).rows);
  });

  app.post('/admin/v1/chargebacks', operator, async (req, reply) => {
    const b = z.object({
      transactionId: uuid, amount: money.optional(), fee: z.union([z.literal(0), money]).optional().transform((v) => (v === 0 ? 0n : v)),
      caseRef: z.string().trim().min(1).max(200).optional(), reasonCode: z.string().trim().max(50).optional(),
      reason: z.string().trim().max(500).optional(), respondBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().trim().max(500).optional(),
    }).safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'invalid_request', b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    try {
      const r = await openChargeback(pool, { ...b.data, source: 'manual' }, who(req));
      if (!r.created) return fail(reply, 409, 'duplicate', 'Чарджбэк с таким ID спора уже заведён');
      return reply.code(201).send(r);
    } catch (err) { return cbError(reply, err); }
  });

  app.post<{ Params: { id: string } }>('/admin/v1/chargebacks/:id/status', operator, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Чарджбэк не найден');
    const b = z.object({ status: z.enum(['evidence_submitted', 'won', 'lost', 'accepted']), note: z.string().trim().max(1000).optional() }).safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'invalid_request', 'Нужен status: evidence_submitted | won | lost | accepted');
    try { await updateChargeback(pool, req.params.id, b.data.status, who(req), b.data.note); return { ok: true }; }
    catch (err) { return cbError(reply, err); }
  });

  // ---------- выписки провайдера ----------

  const csvBody = { bodyLimit: MAX_CSV + 64 * 1024 };
  const fileFields = { accountId: uuid, filename: z.string().trim().min(1).max(200), csv: z.string().min(1).max(MAX_CSV) };

  app.post('/admin/v1/reports/preview', { ...operator, ...csvBody }, async (req, reply) => {
    const b = z.object(fileFields).safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'invalid_request', 'Нужны accountId, filename и csv (до 5 МБ)');
    const acc = (await pool.query(`SELECT provider_id FROM merchant_accounts WHERE id = $1`, [b.data.accountId])).rows[0];
    if (!acc) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const { headers, rows } = parseCsv(b.data.csv);
    if (!headers.length || !rows.length) return fail(reply, 400, 'empty_report', 'В файле нет строк с данными');
    const saved = (await pool.query(`SELECT mapping, amount_unit FROM report_mappings WHERE provider_id = $1`, [acc.provider_id])).rows[0];
    // Запомненное сопоставление подходит, если все его колонки есть в этом файле.
    const savedOk = saved && Object.values(saved.mapping as Mapping).every((h) => !h || headers.includes(h));
    const mapping: Mapping = savedOk ? saved.mapping : autoMapping(headers);
    const amountUnit = savedOk ? saved.amount_unit : 'major';
    return plain({
      headers, rowCount: rows.length, mapping, amountUnit, remembered: !!savedOk,
      fields: FIELDS.map((f) => ({ key: f, title: FIELD_TITLES[f], required: f === 'ref' || f === 'amount' })),
      sample: normalizeRows(headers, rows.slice(0, 5), mapping, amountUnit),
    });
  });

  app.post('/admin/v1/reports/import', { ...operator, ...csvBody }, async (req, reply) => {
    const b = z.object({
      ...fileFields,
      mapping: z.record(z.string(), z.string().nullable()),
      amountUnit: z.enum(['major', 'minor']).default('major'),
    }).safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'invalid_request', 'Нужны accountId, filename, csv и mapping');
    const mapping = Object.fromEntries(FIELDS.map((f) => [f, b.data.mapping[f] || null])) as Mapping;
    if (!mapping.ref || !mapping.amount) return fail(reply, 400, 'mapping_required', 'Укажи колонки «ID платежа у провайдера» и «Сумма»');
    try {
      const r = await importReport(pool, { accountId: b.data.accountId, filename: b.data.filename, csv: b.data.csv, mapping,
        amountUnit: b.data.amountUnit, userId: req.admin!.userId, ip: req.ip });
      return reply.code(201).send(plain(r));
    } catch (err) {
      if ((err as Error).message === 'Аккаунт не найден') return fail(reply, 404, 'not_found', 'Аккаунт не найден');
      throw err;
    }
  });

  app.get('/admin/v1/reports', viewer, async () => plain((await pool.query(
    `SELECT r.id, r.filename, r.uploaded_at, r.period_from, r.period_to, r.rows_total, r.summary, m.name AS account, u.email AS uploaded_by,
            (SELECT count(*)::int FROM report_lines l WHERE l.import_id = r.id AND l.severity IN ('warn', 'bad') AND NOT l.resolved) AS open
     FROM report_imports r JOIN merchant_accounts m ON m.id = r.merchant_account_id LEFT JOIN admin_users u ON u.id = r.uploaded_by
     ORDER BY r.uploaded_at DESC LIMIT 100`)).rows));

  app.get<{ Params: { id: string } }>('/admin/v1/reports/:id', viewer, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Загрузка не найдена');
    const imp = (await pool.query(
      `SELECT r.*, m.name AS account FROM report_imports r JOIN merchant_accounts m ON m.id = r.merchant_account_id WHERE r.id = $1`, [req.params.id])).rows[0];
    if (!imp) return fail(reply, 404, 'not_found', 'Загрузка не найдена');
    const lines = (await pool.query(
      `SELECT l.*, u.email AS resolved_by_email FROM report_lines l LEFT JOIN admin_users u ON u.id = l.resolved_by
       WHERE l.import_id = $1 ORDER BY CASE l.severity WHEN 'bad' THEN 0 WHEN 'warn' THEN 1 WHEN 'info' THEN 2 ELSE 3 END, l.line_no NULLS LAST, l.id`,
      [req.params.id])).rows;
    return plain({ ...imp, lines });
  });

  app.post<{ Params: { id: string } }>('/admin/v1/reports/lines/:id/resolve', operator, async (req, reply) => {
    const b = z.object({ note: z.string().trim().min(3).max(500) }).safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'invalid_request', 'Опиши, что сделано (от 3 символов)');
    const r = await pool.query(
      `UPDATE report_lines SET resolved = true, resolved_by = $2, resolved_at = now(), resolution_note = $3
       WHERE id = $1 AND NOT resolved AND severity IN ('warn', 'bad') RETURNING import_id`, [req.params.id, req.admin!.userId, b.data.note]);
    if (!r.rowCount) return fail(reply, 404, 'not_found', 'Открытое расхождение не найдено');
    await audit(pool, { ...who(req), action: 'report.resolve_line', entity: 'report', entityId: r.rows[0].import_id, after: { line: req.params.id, note: b.data.note } });
    return { ok: true };
  });
}
