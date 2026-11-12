// История платежа и «зависшие деньги».
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { ProviderRegistry, type ProviderAdapter } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { paymentTimeline, stuckMoney } from '../src/admin/insight.js';
import { collectAlerts } from '../src/notify/alerts.js';
import { approveManualLeg, completeManualLeg } from '../src/payouts/payouts.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('История платежа и зависшие деньги', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let mock: MockProvider;
  let providers: ProviderRegistry;
  let key: string;
  let op: string;
  let n = 0;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE audit_log, admin_sessions, admin_users, notifications_sent, player_restriction_events, payout_legs,
      reconciliation_issues, webhook_deliveries, provider_webhook_log, provider_webhook_events, ledger_entries, transaction_attempts,
      transactions, account_usage, players, merchant_accounts, sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses, payout_kyc_required, manual_approval_above, platform_fee_bps)
      VALUES ('Lucky', '{MT}', false, 1000, 150) RETURNING id`)).rows[0].id;
    const k = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'casino', $2)`, [op, k.hash]);
    key = k.key;
    const prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;
    for (const name of ['A', 'B']) {
      await pool.query(`INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, credentials_ref, priority)
        VALUES ($1, $2, $3, '{EUR}', '{MT}', 100, 1000000, 1000000, 'MOCK', $4)`, [op, prov, name, name === 'A' ? 10 : 0]);
    }
    mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    providers = new ProviderRegistry().register(new MockAdapter(mock));
    await app?.close();
    app = buildApp({ pool, mock, providers, secrets: new MapSecretStore({ MOCK: 's' }), rateLimitPerMinute: 100000,
      admin: { encryptionKey: Buffer.alloc(32, 3), secureCookies: false, loginRateLimitPerMinute: 100000 } });
    mock.sink = async (accountId, headers, body) => { await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${accountId}`, headers, payload: body }); };
  });

  const deposit = async (amount = 1000) => (await app.inject({ method: 'POST', url: '/v1/deposits',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': `dep-${++n}-xxxxxx` },
    payload: { amount, currency: 'EUR', player: { id: 'p1', country: 'MT' } } })).json();
  const titles = (t: { events: { title: string }[] }) => t.events.map((e) => e.title);
  const cat = async (k: string) => (await stuckMoney(pool)).categories.find((c) => c.key === k)!;

  it('успешный депозит после отказа первого аккаунта: вся история по порядку', async () => {
    const real = new MockAdapter(mock);
    const accA = (await pool.query(`SELECT id FROM merchant_accounts WHERE name = 'A'`)).rows[0].id;
    providers.register({ name: 'mock', manifest: real.manifest,
      createPayment: async (c, r) => (c.accountId === accA ? { kind: 'declined', reason: 'do_not_honor' } : real.createPayment(c, r)),
      getPayment: (c, r) => real.getPayment(c, r), verifyWebhook: (c, h, b) => real.verifyWebhook(c, h, b) } as ProviderAdapter);
    const d = await deposit();
    await mock.complete(d.paymentUrl.split('/').pop(), 'success');
    const t = (await paymentTimeline(pool, d.id))!;
    expect(t.state).toMatchObject({ tone: 'ok', title: 'Зачислен' });
    expect(titles(t)).toEqual([
      'Сайт casino запросил депозит 10.00 EUR',
      'Попытка 1: выбран аккаунт «A» (Mock)',
      'Провайдер сразу отказал — платёж не создан',
      'Попытка 1 закрыта отказом',
      'Попытка 2: выбран аккаунт «B» (Mock)',
      'Провайдер создал платёж',
      'Вебхук провайдера: принят',
      'Оплата подтверждена провайдером (аккаунт «B»)',
      'Проводки (сходятся)',
    ]);
  });

  it('отправка не подтверждена: состояние, подсказка с ID попытки, категория «зависших», уведомление', async () => {
    const real = new MockAdapter(mock);
    providers.register({ name: 'mock', manifest: real.manifest,
      createPayment: async () => { throw new Error('ETIMEDOUT'); },
      getPayment: (c, r) => real.getPayment(c, r), verifyWebhook: (c, h, b) => real.verifyWebhook(c, h, b) } as ProviderAdapter);
    const d = await deposit(2500);
    const t = (await paymentTimeline(pool, d.id))!;
    expect(t.state).toMatchObject({ tone: 'bad', title: 'Отправка не подтверждена' });
    const attemptId = (await pool.query(`SELECT id FROM transaction_attempts WHERE transaction_id = $1`, [d.id])).rows[0].id;
    expect(t.next.map((x) => x.text).join(' ')).toContain(attemptId);
    expect(titles(t)).toContain('Ответ провайдера на создание потерян');
    const c = await cat('submission_unknown');
    expect(c).toMatchObject({ count: 1, severity: 'bad', totals: [{ currency: 'EUR', amount: 2500n }] });
    expect(c.items[0]!.txId).toBe(d.id);
    // Уведомление — через 10 минут.
    expect((await collectAlerts(pool, 'https://b')).filter((a) => a.key.startsWith('stuck_submit'))).toHaveLength(0);
    await pool.query(`UPDATE transaction_attempts SET submitted_at = now() - interval '11 minutes'`);
    expect((await collectAlerts(pool, 'https://b')).filter((a) => a.key.startsWith('stuck_submit'))).toHaveLength(1);
    // Зарезервированный под этот платёж лимит виден.
    expect((await stuckMoney(pool)).reserved).toEqual([{ currency: 'EUR', amount: 2500n }]);
  });

  it('выплата с ручной частью: части, одобрение и исполнение разными людьми, подсказки', async () => {
    const d = await deposit(1000);
    await mock.complete(d.paymentUrl.split('/').pop(), 'success');
    const po = (await app.inject({ method: 'POST', url: '/v1/payouts', headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'po-1-xxxxxx' },
      payload: { amount: 5000, currency: 'EUR', withdrawalId: 'W-1', player: { id: 'p1' } } })).json();
    let t = (await paymentTimeline(pool, po.id))!;
    expect(t.state).toMatchObject({ title: 'В процессе', detail: 'Осталось выплатить 40.00 EUR' });
    expect(t.next[0]).toMatchObject({ who: 'staff', tab: 'manual' });
    expect((await cat('manual_payouts')).items[0]!.label).toBe('p1 · нужно одобрение');

    const [a, b] = await Promise.all(['a@x.io', 'b@x.io'].map(async (e) =>
      (await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ($1, 'x', 'operator', false) RETURNING id`, [e])).rows[0].id as string));
    const leg = (await pool.query(`SELECT id FROM payout_legs WHERE kind = 'manual'`)).rows[0].id;
    await approveManualLeg(pool, leg, { userId: a! });
    await completeManualLeg(pool, leg, { userId: b! }, { reference: 'SEPA-9', note: '' });
    t = (await paymentTimeline(pool, po.id))!;
    expect(t.state.title).toBe('Выплачено');
    const ev = t.events.map((e) => [e.title, e.actor ?? null]);
    expect(ev).toEqual(expect.arrayContaining([['Ручная выплата одобрена', 'a@x.io'], ['Ручная выплата выполнена', 'b@x.io']]));
    expect(ev.filter(([title]) => String(title).includes('одобр'))).toHaveLength(1); // без дублей из журнала действий
    expect(t.events.find((e) => e.title === 'Ручная выплата выполнена')!.detail).toContain('№ SEPA-9');
    expect(t.events.filter((e) => e.kind === 'ledger').every((e) => e.tone === 'ok')).toBe(true);
    expect((await cat('manual_payouts')).count).toBe(0);
  });

  it('пусто — все категории нулевые; API требует входа', async () => {
    const s = await stuckMoney(pool);
    expect(s.categories.every((c) => c.count === 0)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/stuck' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/transactions/00000000-0000-0000-0000-000000000000/timeline' })).statusCode).toBe(401);
  });
});
