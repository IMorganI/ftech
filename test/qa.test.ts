// Регрессии по итогам QA-прохода: «запрос не отправлен» ≠ «ответ потерян», защита адреса вебхуков,
// коды валют, запрет тестовых провайдеров в production.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { NotSentError, ProviderRegistry, type ProviderAdapter } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { resumePayouts } from '../src/payouts/payouts.js';

const url = process.env.TEST_DATABASE_URL;

describe('конфигурация', () => {
  it('тестовые провайдеры запрещены при NODE_ENV=production', () => {
    const base = { DATABASE_URL: 'postgres://x/y', ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), PUBLIC_BASE_URL: 'https://pay.example' };
    expect(() => loadConfig({ ...base, MOCK_PROVIDER_ENABLED: 'true', NODE_ENV: 'production' })).toThrow(/запрещён/);
    expect(loadConfig({ ...base, MOCK_PROVIDER_ENABLED: 'true', NODE_ENV: 'development' }).MOCK_PROVIDER_ENABLED).toBe(true);
  });
});

describe.skipIf(!url)('QA: регрессии', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let mock: MockProvider;
  let providers: ProviderRegistry;
  let key: string;
  let op: string;
  let prov: string;
  let n = 0;
  const secrets = new MapSecretStore({ MOCK: 's' });

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE payout_legs, reconciliation_issues, provider_webhook_log, provider_webhook_events, ledger_entries,
      transaction_attempts, transactions, account_usage, players, merchant_accounts, sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses, payout_kyc_required) VALUES ('Op', '{MT}', false) RETURNING id`)).rows[0].id;
    const k = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 's', $2)`, [op, k.hash]);
    key = k.key;
    prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;
    mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    providers = new ProviderRegistry().register(new MockAdapter(mock));
    await app?.close();
    app = buildApp({ pool, mock, providers, secrets, rateLimitPerMinute: 100000, webhookRateLimitPerMinute: 40 });
    mock.sink = async (accountId, headers, body) => { await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${accountId}`, headers, payload: body }); };
  });

  const account = async (name: string, o: { fee?: number; ref?: string | null } = {}) => (await pool.query(
    `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, credentials_ref)
     VALUES ($1, $2, $3, '{EUR}', '{MT}', 100, 1000000, 10000000, $4, $5) RETURNING id`, [op, prov, name, o.fee ?? 100, o.ref === undefined ? 'MOCK' : o.ref])).rows[0].id as string;
  const deposit = async (amount = 1000, currency = 'EUR') => app.inject({ method: 'POST', url: '/v1/deposits',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': `qa-${++n}-xxxxxx` },
    payload: { amount, currency, player: { id: `p${n}`, country: 'MT' } } });
  const attempts = async (txId: string) => (await pool.query(
    `SELECT m.name, a.status, a.submit_outcome, a.error FROM transaction_attempts a JOIN merchant_accounts m ON m.id = a.merchant_account_id
     WHERE a.transaction_id = $1 ORDER BY a.attempt_no`, [txId])).rows;

  it('у аккаунта нет ключей — платёж сразу уходит на следующий аккаунт, а не висит «неизвестно»', async () => {
    await account('без ключей', { fee: 50, ref: null }); // дешевле — роутер выберет его первым
    await account('рабочий', { fee: 200 });
    const d = (await deposit()).json();
    expect(d.status).toBe('pending');
    expect(d.paymentUrl).toMatch(/^https:\/\/pay\.test/);
    const a = await attempts(d.id);
    expect(a.map((x) => [x.name, x.status, x.submit_outcome])).toEqual([['без ключей', 'declined', 'declined'], ['рабочий', 'pending', 'created']]);
    expect(a[0].error).toMatch(/^not_sent: .*ключи/);
  });

  it('адаптер сообщил «не отправлено» (нет токена) — каскад; сетевая ошибка посреди запроса — без каскада', async () => {
    const accA = await account('A', { fee: 50 }); await account('B', { fee: 200 });
    const real = new MockAdapter(mock);
    let mode: 'notsent' | 'lost' = 'notsent';
    providers.register({ name: 'mock', manifest: real.manifest, paymentTtlSec: 1800,
      createPayment: async (c, r) => {
        if (c.accountId === accA) { if (mode === 'notsent') throw new NotSentError('нет токена'); throw new Error('socket hang up'); }
        return real.createPayment(c, r);
      },
      getPayment: (c, r) => real.getPayment(c, r), verifyWebhook: (c, h, b) => real.verifyWebhook(c, h, b) } as ProviderAdapter);
    const d1 = (await deposit()).json();
    expect((await attempts(d1.id)).map((x) => x.name)).toEqual(['A', 'B']);
    mode = 'lost';
    const d2 = (await deposit()).json();
    expect((await attempts(d2.id)).map((x) => [x.name, x.submit_outcome])).toEqual([['A', 'unknown']]);
  });

  it('возврат не отправлен (нет ключей/токена) — часть возвращается в очередь, без ложной «проблемы»; потом проходит', async () => {
    await account('A');
    const d = (await deposit(5000)).json();
    await mock.complete(d.paymentUrl.split('/').pop(), 'success');
    const real = new MockAdapter(mock);
    let broken = true;
    providers.register({ name: 'mock', manifest: real.manifest, createPayment: (c, r) => real.createPayment(c, r),
      getPayment: (c, r) => real.getPayment(c, r), verifyWebhook: (c, h, b) => real.verifyWebhook(c, h, b),
      refund: async (c, r) => { if (broken) throw new NotSentError('нет токена'); return real.refund(c, r); } } as ProviderAdapter);
    const po = (await app.inject({ method: 'POST', url: '/v1/payouts', headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'qa-po-0001' },
      payload: { amount: 3000, currency: 'EUR', withdrawalId: 'W-qa', player: { id: d.id ? `p${n}` : '' } } })).json();
    expect(po.status).toBe('pending');
    const leg = (await pool.query(`SELECT submitted_at, error FROM payout_legs WHERE kind = 'refund'`)).rows[0];
    expect(leg.submitted_at).toBeNull();
    expect(leg.error).toMatch(/^not_sent/);
    expect((await pool.query(`SELECT count(*)::int c FROM reconciliation_issues`)).rows[0].c).toBe(0);
    broken = false;
    await pool.query(`UPDATE payout_legs SET created_at = now() - interval '5 minutes'`);
    expect(await resumePayouts({ pool, providers, secrets }, 60)).toBe(1);
    expect((await pool.query(`SELECT status FROM transactions WHERE id = $1`, [po.id])).rows[0].status).toBe('success');
  });

  it('неизвестный код валюты — ошибка запроса, а не отказ в аналитике', async () => {
    await account('A');
    const r = await deposit(1000, 'XXX');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details[0].message).toMatch(/Неизвестный код валюты/);
    expect((await deposit(1000, 'UAH')).statusCode).toBe(201); // настоящая валюта — платёж создаётся (отказ no_route)
  });

  it('адрес вебхуков провайдера: ограничение частоты, мусор не раздувает журнал', async () => {
    const acc = await account('A');
    await pool.query(`UPDATE merchant_accounts SET webhook_token = 'tok' WHERE id = $1`, [acc]);
    // mock — внутренний (без токена), поэтому шлём мусор с неверной подписью
    const codes: number[] = [];
    for (let i = 0; i < 45; i++) {
      codes.push((await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${acc}`, payload: { junk: i }, headers: { 'content-type': 'application/json' } })).statusCode);
    }
    expect(codes.filter((c) => c === 401).length).toBe(40);
    expect(codes.filter((c) => c === 429).length).toBe(5);
    expect((await pool.query(`SELECT count(*)::int c FROM provider_webhook_log WHERE outcome = 'rejected'`)).rows[0].c).toBe(30);
  });
});
