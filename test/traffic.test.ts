// Распределение трафика: уровни (основной/резерв), веса, «максимум сейчас», ёмкость.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { capacity } from '../src/admin/capacity.js';
import { collectAlerts } from '../src/notify/alerts.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Распределение трафика', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let mock: MockProvider;
  let key: string;
  let op: string;
  let prov: string;
  let n = 0;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE notifications_sent, ledger_entries, transaction_attempts, transactions, account_usage, players,
      merchant_accounts, sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses, routing_mode) VALUES ('Op', '{MT}', 'weights') RETURNING id`)).rows[0].id;
    const k = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 's', $2)`, [op, k.hash]);
    key = k.key;
    prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;
    mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    await app?.close();
    app = buildApp({ pool, mock, providers: new ProviderRegistry().register(new MockAdapter(mock)), secrets: new MapSecretStore({ MOCK: 's' }), rateLimitPerMinute: 100000 });
  });

  async function account(name: string, o: { weight?: number; tier?: string; cap?: number; fee?: number; prio?: number; max?: number } = {}) {
    return (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, priority, weight, tier, switch_at_bps, credentials_ref)
       VALUES ($1, $2, $3, '{EUR}', '{MT}', 100, $4, $5, $6, $7, $8, $9, 10000, 'MOCK') RETURNING id`,
      [op, prov, name, o.max ?? 1_000_000, o.cap ?? 100_000_000, o.fee ?? 200, o.prio ?? 0, o.weight ?? 100, o.tier ?? 'primary'])).rows[0].id as string;
  }
  // Новый игрок на каждый депозит — чтобы «липкость» к прошлому аккаунту не мешала проверять доли.
  const deposit = async (amount: number) => (await app.inject({ method: 'POST', url: '/v1/deposits',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': `t-${++n}-xxxxxx` },
    payload: { amount, currency: 'EUR', player: { id: `p${n}`, country: 'MT' } } })).json();
  const byAccount = async () => Object.fromEntries((await pool.query(
    `SELECT m.name, coalesce(sum(t.amount), 0)::bigint s FROM merchant_accounts m LEFT JOIN transactions t ON t.merchant_account_id = m.id
     GROUP BY m.name`)).rows.map((r) => [r.name, Number(r.s)]));

  it('по весам 60/30/10: оборот распределяется по долям, а не «по очереди до упора»', async () => {
    await account('A', { weight: 60 }); await account('B', { weight: 30 }); await account('C', { weight: 10 });
    for (let i = 0; i < 100; i++) await deposit(1000);
    expect(await byAccount()).toEqual({ A: 60000, B: 30000, C: 10000 });
    const reason = (await pool.query(`SELECT route_reason FROM transaction_attempts ORDER BY created_at DESC LIMIT 1`)).rows[0].route_reason;
    expect(reason).toMatch(/доля по весам: вес \d+%, сегодня было \d+% оборота/);
  });

  it('по порядку (как раньше): сначала дешёвый аккаунт до заполнения лимита', async () => {
    await pool.query(`UPDATE operators SET routing_mode = 'fill'`);
    await account('cheap', { fee: 100, cap: 5000 }); await account('dear', { fee: 300 });
    for (let i = 0; i < 8; i++) await deposit(1000);
    expect(await byAccount()).toEqual({ cheap: 5000, dear: 3000 });
  });

  it('резерв получает платежи, только когда основные не подходят', async () => {
    await account('main', { cap: 3000 }); await account('spare', { tier: 'reserve' });
    for (let i = 0; i < 5; i++) await deposit(1000);
    expect(await byAccount()).toEqual({ main: 3000, spare: 2000 });
    const reasons = (await pool.query(`SELECT route_reason FROM transaction_attempts ORDER BY created_at`)).rows.map((r) => r.route_reason);
    expect(reasons.filter((r) => r.startsWith('РЕЗЕРВ'))).toHaveLength(2);
  });

  it('крупный платёж — туда, где хватает лимита; если нигде — capacity_exhausted с «максимум сейчас»', async () => {
    await account('small', { cap: 3000, weight: 90 }); await account('big', { cap: 20000, weight: 10 });
    const d = await deposit(15000);
    expect(d.status).toBe('pending');
    expect((await pool.query(`SELECT m.name FROM transactions t JOIN merchant_accounts m ON m.id = t.merchant_account_id`)).rows[0].name).toBe('big');
    const no = await deposit(9000);
    expect(no).toMatchObject({ status: 'declined', declineCode: 'capacity_exhausted', declineDetails: { maxAmountNow: '5000' } });
  });

  it('сумма вне диапазона всех аккаунтов — no_route (дело не в лимитах)', async () => {
    await account('A', { max: 5000 });
    expect((await deposit(9000)).declineCode).toBe('no_route');
  });

  it('ёмкость: свободно по валюте и уровням, темп и прогноз; уведомления 70% и 90%', async () => {
    await account('main', { cap: 10000 }); await account('spare', { tier: 'reserve', cap: 10000 });
    for (let i = 0; i < 7; i++) await deposit(1000);
    let c = (await capacity(pool)).currencies.find((x) => x.currency === 'EUR')!;
    expect(c).toMatchObject({ limit: 20000n, taken: 7000n, free: 13000n });
    expect(c.tiers.primary).toMatchObject({ limit: 10000n, taken: 7000n });
    expect(c.ratePerHour).toBe(7000n);
    expect(c.exhaustInMin).toBeGreaterThan(100); // 13000 при темпе 7000/ч ≈ 111 мин
    expect(c.accounts.find((a) => a.name === 'main')!.fillPct).toBe(70);
    for (let i = 0; i < 7; i++) await deposit(1000);
    c = (await capacity(pool)).currencies[0]!;
    expect(c.fillPct).toBe(70);
    let keys = (await collectAlerts(pool, 'https://b')).map((a) => a.key).filter((k) => k.startsWith('capacity:'));
    expect(keys).toEqual([expect.stringMatching(/^capacity:EUR:70:/)]);
    for (let i = 0; i < 4; i++) await deposit(1000);
    keys = (await collectAlerts(pool, 'https://b')).map((a) => a.key).filter((k) => k.startsWith('capacity:'));
    expect(keys).toEqual([expect.stringMatching(/^capacity:EUR:70:/), expect.stringMatching(/^capacity:EUR:90:/)]);
  });
});
