import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isCurrency } from '../money/currencies.js';
import { decrypt } from '../crypto.js';
import type { ProviderRegistry, ProviderAdapter } from '../providers/types.js';
import type { SecretStore } from '../secrets.js';
import { accountCredentials, buildSecret, describeValues, encryptSecret, ensureWebhookToken, hasValue } from '../providers/credentials.js';
import { requireAdmin, audit, bigintReplacer, type AdminDeps } from './auth.js';

/*
 * «Подключения»: ключи провайдеров в борде (зашифрованы в базе), проверка подключения,
 * готовый адрес вебхука и чек-лист готовности оператора.
 */

export interface ConnectionDeps extends AdminDeps {
  providers: ProviderRegistry;
  secrets: SecretStore;
  /** Публичный адрес, на который провайдер шлёт вебхуки (в Codespaces можно задать адрес туннеля). */
  webhookBaseUrl: string;
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v, bigintReplacer));
const fail = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });
const uuid = z.string().uuid();

export async function connectionRoutes(app: FastifyInstance, d: ConnectionDeps) {
  const { pool } = d;
  const viewer = { preHandler: requireAdmin(d, 'viewer') };
  const operator = { preHandler: requireAdmin(d, 'operator') };
  const admin = { preHandler: requireAdmin(d, 'admin') };

  const adapterOf = (name: string): ProviderAdapter | null => { try { return d.providers.get(name); } catch { return null; } };

  // Доступные интеграции и какие ключи для них нужны.
  app.get('/admin/v1/connectors', viewer, async () => d.providers.list().map((a) => ({ name: a.name, ...a.manifest })));

  const money = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,17}$/)]).transform((v) => BigInt(v));

  // Новый платёжный аккаунт сразу с интеграцией: запись провайдера создаётся сама.
  app.post('/admin/v1/connections/accounts', admin, async (req, reply) => {
    const b = z.object({
      operatorId: uuid, adapter: z.string().min(1).max(40), name: z.string().min(1).max(200),
      currencies: z.array(z.string().regex(/^[A-Z]{3}$/).refine(isCurrency, 'Неизвестный код валюты ISO 4217')).length(1, 'Одна валюта на аккаунт: лимиты считаются в ней'), countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
      minAmount: money, maxAmount: money, dailyCap: money, monthlyCap: money.nullable().default(null),
      feeBps: z.number().int().min(0).max(10000).default(0), priority: z.number().int().min(-1000).max(1000).default(0),
    }).safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'invalid_request', b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = b.data;
    const adapter = adapterOf(v.adapter);
    if (!adapter) return fail(reply, 400, 'invalid_request', `Интеграция «${v.adapter}» не подключена на сервере`);
    if (v.maxAmount < v.minAmount) return fail(reply, 400, 'invalid_request', 'Максимальный платёж меньше минимального');
    if (v.monthlyCap !== null && v.monthlyCap < v.dailyCap) return fail(reply, 400, 'invalid_request', 'Месячный лимит меньше дневного');
    const prov = (await pool.query(
      `INSERT INTO providers (code, name, adapter) VALUES ($1, $2, $1)
       ON CONFLICT (code) DO UPDATE SET name = providers.name RETURNING id`, [adapter.name, adapter.manifest.title])).rows[0].id;
    // Интеграции без ключей (тестовая) получают случайный секрет для подписи сразу и включаются сразу.
    // Остальные создаются выключенными: в маршрутизацию аккаунт попадает, когда ключи введены и проверены.
    const needsKeys = adapter.manifest.fields.some((f) => f.required);
    const enc = adapter.manifest.fields.length ? null : encryptSecret(d.encryptionKey, buildSecret(adapter, null, {}));
    try {
      const row = (await pool.query(
        `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap,
           monthly_cap, fee_bps, priority, credentials_enc, enabled, webhook_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, encode(gen_random_bytes(24), 'hex')) RETURNING id, name`,
        [v.operatorId, prov, v.name, v.currencies, v.countries, v.minAmount, v.maxAmount, v.dailyCap, v.monthlyCap, v.feeBps, v.priority, enc, !needsKeys])).rows[0];
      await audit(pool, { userId: req.admin!.userId, action: 'account.create', entity: 'account', entityId: row.id, ip: req.ip,
        after: { name: v.name, adapter: adapter.name, currencies: v.currencies, countries: v.countries } });
      return reply.code(201).send({ id: row.id, name: row.name, needsCredentials: needsKeys, enabled: !needsKeys });
    } catch (err) {
      if ((err as { code?: string }).code === '23503') return fail(reply, 400, 'invalid_request', 'Оператор не найден');
      throw err;
    }
  });

  async function account(id: string) {
    return (await pool.query(
      `SELECT m.id, m.name, m.operator_id, m.enabled, m.credentials_enc, m.credentials_ref, m.last_check_at, m.last_check_ok, m.last_check,
              p.adapter, p.code AS provider_code
       FROM merchant_accounts m JOIN providers p ON p.id = m.provider_id WHERE m.id = $1`, [id])).rows[0];
  }

  /**
   * Подключение аккаунта по шагам, одинаково для любого провайдера:
   *  1. keys    — ключи API введены;   2. check — провайдер их принимает;
   *  3. webhook — вебхук настроен и хотя бы раз дошёл с верной подписью;   4. live — включён и был успешный платёж.
   */
  app.get<{ Params: { id: string } }>('/admin/v1/accounts/:id/connection', viewer, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const a = await account(req.params.id);
    if (!a) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const adapter = adapterOf(a.adapter);
    let secret: string | null = null;
    try { secret = a.credentials_enc ? decrypt(d.encryptionKey, a.credentials_enc) : null; } catch { secret = null; }
    const m = adapter?.manifest;
    const fields = m?.fields ?? [];
    const scheme = m?.webhook.scheme ?? 'internal';
    const token = scheme === 'internal' ? null : await ensureWebhookToken(d, a.id);

    const log = (await pool.query(
      `SELECT received_at AS at, method, outcome, reason, event_id, provider_ref FROM provider_webhook_log
       WHERE merchant_account_id = $1 ORDER BY received_at DESC, id DESC LIMIT 15`, [a.id])).rows;
    const stats = (await pool.query(
      `SELECT max(received_at) FILTER (WHERE outcome IN ('accepted', 'test', 'duplicate')) AS ok_at,
              max(received_at) FILTER (WHERE outcome IN ('rejected', 'error')) AS bad_at,
              (SELECT max(received_at) FROM provider_webhook_events WHERE merchant_account_id = $1) AS legacy_at
       FROM provider_webhook_log WHERE merchant_account_id = $1`, [a.id])).rows[0];
    const lastOk = [stats.ok_at, stats.legacy_at].filter(Boolean).sort((x: Date, y: Date) => +y - +x)[0] ?? null;
    const lastBad = stats.bad_at ? log.find((r) => r.outcome === 'rejected' || r.outcome === 'error') ?? { at: stats.bad_at, reason: null } : null;
    const webhookState = scheme === 'internal' ? 'internal'
      : lastBad && (!lastOk || +lastBad.at > +lastOk) ? 'failing' : lastOk ? 'ok' : 'waiting';

    const firstSuccess = (await pool.query(
      `SELECT min(created_at) AS at FROM transactions WHERE merchant_account_id = $1 AND type = 'deposit' AND status = 'success'`, [a.id])).rows[0].at;
    const secretField = fields.find((f) => f.stage === 'webhook') ?? null;
    const keysDone = !!(a.credentials_enc || a.credentials_ref) && fields.filter((f) => f.required && f.stage !== 'webhook')
      .every((f) => a.credentials_ref || hasValue(secret, f.key));
    const steps = {
      keys: keysDone || !fields.length,
      check: !!a.last_check_ok,
      webhook: scheme === 'internal' || (webhookState === 'ok' && (!secretField || !!a.credentials_ref || hasValue(secret, secretField.key))),
      live: !!a.enabled && !!firstSuccess,
    };

    return plain({
      id: a.id, name: a.name, enabled: a.enabled,
      adapter: a.adapter, adapterAvailable: !!adapter,
      title: m?.title ?? a.adapter, summary: m?.summary ?? '', methods: m?.methods ?? [], links: m?.links ?? {},
      capabilities: m?.capabilities ?? null,
      source: a.credentials_enc ? 'board' : a.credentials_ref ? 'env' : null,
      fields, values: adapter ? describeValues(adapter, secret) : {},
      webhook: {
        scheme, events: m?.webhook.events ?? [], steps: m?.webhook.steps ?? [], note: m?.webhook.note ?? null,
        url: token ? `${d.webhookBaseUrl}/v1/provider-webhooks/${a.id}?token=${token}` : null,
        secretField: secretField?.key ?? null, secretSet: secretField ? hasValue(secret, secretField.key) : null,
        state: webhookState, lastOkAt: lastOk, lastError: lastBad ? { at: lastBad.at, reason: lastBad.reason } : null,
        log,
      },
      lastCheck: a.last_check_at ? { at: a.last_check_at, ok: a.last_check_ok, results: a.last_check } : null,
      firstSuccessAt: firstSuccess,
      steps, ready: steps.keys && steps.check && steps.live,
    });
  });

  // Новый адрес вебхука (если старый утёк или ушёл не туда). Старый перестаёт работать сразу.
  app.post<{ Params: { id: string } }>('/admin/v1/accounts/:id/webhook-token', admin, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const r = await pool.query(`UPDATE merchant_accounts SET webhook_token = encode(gen_random_bytes(24), 'hex') WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rowCount) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    await audit(pool, { userId: req.admin!.userId, action: 'account.webhook_token', entity: 'account', entityId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  // Сохранить ключи: шифруются ENCRYPTION_KEY, в журнал пишется только какие поля менялись.
  app.put<{ Params: { id: string } }>('/admin/v1/accounts/:id/credentials', admin, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const body = z.object({ values: z.record(z.string(), z.string().max(500)) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'invalid_request', 'Нужен объект values с полями ключей');
    const a = await account(req.params.id);
    if (!a) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const adapter = adapterOf(a.adapter);
    if (!adapter) return fail(reply, 400, 'invalid_request', `Интеграция «${a.adapter}» не подключена на сервере`);
    // Старый токен вебхука (лежал в ключах Viva) переносим до перезаписи ключей — адрес у провайдера не сломается.
    await ensureWebhookToken(d, a.id).catch(() => {});
    let previous: string | null = null;
    try { previous = a.credentials_enc ? decrypt(d.encryptionKey, a.credentials_enc) : null; } catch { previous = null; }
    let secret: string;
    try { secret = buildSecret(adapter, previous, body.data.values); } catch (err) {
      return fail(reply, 400, 'invalid_credentials', (err as Error).message);
    }
    await pool.query(
      `UPDATE merchant_accounts SET credentials_enc = $2, last_check_at = NULL, last_check_ok = NULL, last_check = NULL WHERE id = $1`,
      [a.id, encryptSecret(d.encryptionKey, secret)]);
    const changed = Object.entries(body.data.values).filter(([, v]) => v.trim()).map(([k]) => k);
    await audit(pool, { userId: req.admin!.userId, action: 'account.credentials', entity: 'account', entityId: a.id, ip: req.ip,
      after: { fields: changed } });
    return { ok: true };
  });

  // Проверить подключение у провайдера (без создания платежей) и запомнить результат.
  app.post<{ Params: { id: string } }>('/admin/v1/accounts/:id/check', operator, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const a = await account(req.params.id);
    if (!a) return fail(reply, 404, 'not_found', 'Аккаунт не найден');
    const adapter = adapterOf(a.adapter);
    let results;
    if (!adapter) results = [{ name: 'Интеграция', ok: false, message: `«${a.adapter}» не подключена на сервере` }];
    else {
      try {
        const creds = await accountCredentials(d, a.id);
        results = adapter.checkConnection ? await adapter.checkConnection(creds)
          : [{ name: 'Проверка', ok: true, message: 'Для этой интеграции автоматической проверки нет' }];
      } catch (err) {
        results = [{ name: 'Ключи', ok: false, message: (err as Error).message }];
      }
    }
    const ok = results.every((r) => r.ok);
    await pool.query(`UPDATE merchant_accounts SET last_check_at = now(), last_check_ok = $2, last_check = $3 WHERE id = $1`,
      [a.id, ok, JSON.stringify(results)]);
    return { ok, results };
  });

  // Готовность оператора к приёму платежей: что сделано и что осталось.
  app.get<{ Params: { id: string } }>('/admin/v1/operators/:id/readiness', viewer, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return fail(reply, 404, 'not_found', 'Оператор не найден');
    const r = (await pool.query(
      `SELECT
         (SELECT count(*) FROM merchant_accounts WHERE operator_id = $1)::int AS accounts,
         (SELECT count(*) FROM merchant_accounts WHERE operator_id = $1 AND enabled)::int AS enabled,
         (SELECT count(*) FROM merchant_accounts WHERE operator_id = $1 AND (credentials_enc IS NOT NULL OR credentials_ref IS NOT NULL))::int AS with_keys,
         (SELECT count(*) FROM merchant_accounts WHERE operator_id = $1 AND enabled AND credentials_enc IS NULL AND credentials_ref IS NULL)::int AS without_keys,
         (SELECT count(*) FROM merchant_accounts WHERE operator_id = $1 AND last_check_ok)::int AS checked,
         (SELECT count(*) FROM sites WHERE operator_id = $1 AND enabled)::int AS sites,
         ((SELECT count(*) FROM provider_webhook_events e JOIN merchant_accounts m ON m.id = e.merchant_account_id WHERE m.operator_id = $1)
          + (SELECT count(*) FROM provider_webhook_log l JOIN merchant_accounts m ON m.id = l.merchant_account_id
             WHERE m.operator_id = $1 AND l.outcome IN ('accepted', 'test')))::int AS webhooks,
         (SELECT count(*) FROM transactions t JOIN sites s ON s.id = t.site_id WHERE s.operator_id = $1 AND t.type = 'deposit' AND t.status = 'success')::int AS deposits,
         (SELECT platform_fee_bps FROM operators WHERE id = $1) AS fee`, [req.params.id])).rows[0];
    if (r.fee === null) return fail(reply, 404, 'not_found', 'Оператор не найден');
    const steps = [
      { key: 'account', done: r.accounts > 0, title: 'Платёжный аккаунт', hint: 'Подключи аккаунт провайдера (Viva, TestPay…)' },
      { key: 'keys', done: r.with_keys > 0 && r.without_keys === 0, title: 'Ключи провайдера', hint: 'Введи ключи в карточке аккаунта (шаг 1)' },
      { key: 'check', done: r.checked > 0, title: 'Проверка подключения', hint: 'Нажми «Проверить» в карточке аккаунта (шаг 2)' },
      { key: 'enabled', done: r.enabled > 0, title: 'Аккаунт включён в маршрутизацию', hint: 'Включи аккаунт в карточке (шаг 4) — до этого платежи на него не идут' },
      { key: 'site', done: r.sites > 0, title: 'Сайт подключён', hint: 'Создай сайт и передай разработчикам казино API-ключ' },
      { key: 'fee', done: r.fee > 0, title: 'Комиссия платформы', hint: 'Укажи свой процент, иначе заработок будет 0', optional: true },
      { key: 'webhook', done: r.webhooks > 0, title: 'Вебхуки провайдера', hint: 'Настрой вебхук у провайдера — статусы будут обновляться за секунды', optional: true },
      { key: 'deposit', done: r.deposits > 0, title: 'Первый успешный депозит', hint: 'Проведи тестовый платёж' },
    ];
    return { steps, ready: steps.filter((s) => !s.optional).every((s) => s.done) };
  });
}
