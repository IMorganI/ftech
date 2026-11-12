// Денежные сценарии роутера. Нужна реальная PostgreSQL: TEST_DATABASE_URL (в CI задаётся автоматически).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { resolveAttempt } from '../src/routing/router.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Депозиты и роутинг', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let key: string;
  let otherKey: string;
  let op: string;
  let prov: string;
  let n = 0;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    app = buildApp({ ...deps(), rateLimitPerMinute: 100000 });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  function deps() {
    const mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    return { pool, mock, providers: new ProviderRegistry().register(new MockAdapter(mock)), secrets: new MapSecretStore({ MOCK: 'test-secret' }) };
  }

  beforeEach(async () => {
    await pool.query(`TRUNCATE ledger_entries, transaction_attempts, transactions, account_usage, players,
                      merchant_accounts, sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses, kyc_required_above, max_attempts)
      VALUES ('Op', '{MT,DE,BR}', 30000, 3) RETURNING id`)).rows[0].id;
    const k1 = generateApiKey(); const k2 = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'S1', $2), ($1, 'S2', $3)`, [op, k1.hash, k2.hash]);
    key = k1.key; otherKey = k2.key;
    prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;
  });

  async function account(name: string, o: { cap?: number; fee?: number; prio?: number; cur?: string; geo?: string; min?: number; max?: number; monthly?: number } = {}) {
    return (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, monthly_cap, fee_bps, priority, credentials_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'MOCK') RETURNING id`,
      [op, prov, name, `{${o.cur ?? 'EUR'}}`, `{${o.geo ?? 'MT,DE'}}`, o.min ?? 100, o.max ?? 1_000_000,
       o.cap ?? 1_000_000, o.monthly ?? null, o.fee ?? 250, o.prio ?? 0],
    )).rows[0].id as string;
  }

  function deposit(amount: number | string, player: Record<string, unknown> = {}, opts: { key?: string; idem?: string } = {}) {
    return app.inject({
      method: 'POST', url: '/v1/deposits',
      headers: { authorization: `Bearer ${opts.key ?? key}`, 'idempotency-key': opts.idem ?? `idem-${++n}-${Date.now()}` },
      payload: { amount, currency: 'EUR', player: { id: 'p1', country: 'MT', kyc: 'verified', ...player } },
    });
  }

  async function txRow(id: string) {
    return (await pool.query(`SELECT * FROM transactions WHERE id = $1`, [id])).rows[0];
  }
  async function usage(accountId: string) {
    const r = (await pool.query(`SELECT coalesce(sum(used),0)::bigint used, coalesce(sum(reserved),0)::bigint reserved
      FROM account_usage WHERE merchant_account_id = $1`, [accountId])).rows[0];
    return { used: r.used as bigint, reserved: r.reserved as bigint };
  }

  // ---------- доступ и валидация ----------

  it('без ключа — 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/deposits', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('с чужим/неверным ключом — 401', async () => {
    const res = await deposit(1000, {}, { key: 'ftk_wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('без Idempotency-Key — 400', async () => {
    await account('A');
    const res = await app.inject({ method: 'POST', url: '/v1/deposits', headers: { authorization: `Bearer ${key}` },
      payload: { amount: 1000, currency: 'EUR', player: { id: 'p1', country: 'MT' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('дробная или отрицательная сумма — 400', async () => {
    for (const bad of [10.5, -100, 0, '01', 'abc']) {
      const res = await deposit(bad as number);
      expect(res.statusCode, String(bad)).toBe(400);
    }
  });

  // ---------- базовый роутинг ----------

  it('создаёт депозит на самом дешёвом аккаунте и резервирует сумму', async () => {
    const expensive = await account('Дорогой', { fee: 300 });
    const cheap = await account('Дешёвый', { fee: 150 });
    const res = await deposit(5000);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('pending');
    expect(body.amount).toBe('5000');
    expect((await txRow(body.id)).merchant_account_id).toBe(cheap);
    expect(await usage(cheap)).toEqual({ used: 0n, reserved: 5000n });
    expect(await usage(expensive)).toEqual({ used: 0n, reserved: 0n });
  });

  it('приоритет важнее комиссии', async () => {
    const prio = await account('Приоритетный', { fee: 400, prio: 10 });
    await account('Дешёвый', { fee: 100 });
    const res = await deposit(5000);
    expect((await txRow(res.json().id)).merchant_account_id).toBe(prio);
  });

  it('учитывает валюту, страну и мин/макс сумму', async () => {
    await account('BRL only', { cur: 'BRL', geo: 'BR' });
    await account('Только крупные', { min: 100_000 });
    const ok = await account('Подходит', { fee: 900 });
    const res = await deposit(5000);
    expect((await txRow(res.json().id)).merchant_account_id).toBe(ok);
  });

  it('нет подходящего аккаунта — declined no_route', async () => {
    await account('BRL only', { cur: 'BRL', geo: 'BR' });
    const res = await deposit(5000);
    expect(res.json()).toMatchObject({ status: 'declined', declineCode: 'no_route' });
  });

  // ---------- лимиты аккаунтов ----------

  it('переключается на следующий аккаунт на 95% дневного лимита', async () => {
    const a = await account('A', { cap: 10_000, fee: 100 });
    const b = await account('B', { cap: 10_000, fee: 200 });
    // A: порог 9 500
    expect((await txRow((await deposit(5000)).json().id)).merchant_account_id).toBe(a);
    expect((await txRow((await deposit(4000, { id: 'p2' })).json().id)).merchant_account_id).toBe(a); // 9 000
    expect((await txRow((await deposit(1000, { id: 'p3' })).json().id)).merchant_account_id).toBe(b); // 10 000 > 9 500
    expect((await txRow((await deposit(500, { id: 'p4' })).json().id)).merchant_account_id).toBe(a);  // 9 500 = порог, влезает
  });

  it('учитывает месячный лимит', async () => {
    const a = await account('A', { cap: 10_000, monthly: 20_000, fee: 100 });
    const b = await account('B', { fee: 200 });
    await pool.query(`INSERT INTO account_usage (merchant_account_id, day, currency, used)
      VALUES ($1, (date_trunc('month', now() AT TIME ZONE 'UTC') )::date, 'EUR', 18_500)
      ON CONFLICT (merchant_account_id, day, currency) DO UPDATE SET used = 18500`, [a]);
    // месячный порог 19 000; на сегодня 18 500 уже есть (если сегодня 1-е — это та же строка)
    const res = await deposit(1000);
    expect((await txRow(res.json().id)).merchant_account_id).toBe(b);
  });

  // ---------- лимиты и статус игрока: отказ, а не перекидывание ----------

  it('самоисключённый игрок — отказ', async () => {
    await account('A');
    expect((await deposit(1000, { selfExcluded: true })).json()).toMatchObject({ status: 'declined', declineCode: 'player_self_excluded' });
  });

  it('страна вне лицензии оператора — отказ', async () => {
    await account('A', { geo: 'MT,DE,FR' });
    expect((await deposit(1000, { country: 'FR' })).json()).toMatchObject({ status: 'declined', declineCode: 'country_not_licensed' });
  });

  it('без KYC выше порога — отказ, ниже — проходит', async () => {
    await account('A');
    expect((await deposit(30_001, { kyc: 'none' })).json().declineCode).toBe('kyc_required');
    expect((await deposit(30_000, { kyc: 'none' })).json().status).toBe('pending');
    expect((await deposit(1000, { kyc: 'rejected', id: 'p9' })).json().declineCode).toBe('kyc_rejected');
  });

  it('превышен дневной лимит игрока — отказ, даже если у аккаунтов есть место', async () => {
    await account('A'); await account('B');
    expect((await deposit(6000, { depositLimitDaily: 10_000 })).json().status).toBe('pending');
    const r = (await deposit(5000, { depositLimitDaily: 10_000 })).json();
    expect(r).toMatchObject({ status: 'declined', declineCode: 'player_limit_exceeded' });
    expect((await deposit(4000, { depositLimitDaily: 10_000 })).json().status).toBe('pending'); // ровно 10 000
  });

  it('отклонённые депозиты не съедают лимит игрока', async () => {
    await account('A', { max: 5000 });
    expect((await deposit(9000, { depositLimitDaily: 10_000 })).json().declineCode).toBe('no_route');
    expect((await deposit(5000, { depositLimitDaily: 10_000 })).json().status).toBe('pending');
  });

  // ---------- идемпотентность ----------

  it('повтор с тем же ключом возвращает тот же платёж и не резервирует дважды', async () => {
    const a = await account('A');
    const r1 = await deposit(5000, {}, { idem: 'same-key-1' });
    const r2 = await deposit(5000, {}, { idem: 'same-key-1' });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().id).toBe(r1.json().id);
    expect(await usage(a)).toEqual({ used: 0n, reserved: 5000n });
  });

  it('тот же ключ с другой суммой — 409', async () => {
    await account('A');
    await deposit(5000, {}, { idem: 'same-key-2' });
    const r = await deposit(7000, {}, { idem: 'same-key-2' });
    expect(r.statusCode).toBe(409);
  });

  it('одинаковые параллельные запросы создают один платёж', async () => {
    const a = await account('A');
    const rs = await Promise.all(Array.from({ length: 8 }, () => deposit(5000, {}, { idem: 'parallel-key' })));
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
    expect(await usage(a)).toEqual({ used: 0n, reserved: 5000n });
  });

  // ---------- результат попытки, проводки, липкость ----------

  it('успех: резерв становится оборотом, проводки сходятся в ноль', async () => {
    const a = await account('A');
    const id = (await deposit(5000)).json().id;
    const tx = await resolveAttempt(pool, id, { status: 'success', providerRef: 'prov-1' });
    expect(tx.status).toBe('success');
    expect(await usage(a)).toEqual({ used: 5000n, reserved: 0n });
    const sum = (await pool.query(`SELECT sum(amount)::bigint s, count(*)::int c FROM ledger_entries WHERE transaction_id = $1`, [id])).rows[0];
    expect(sum).toEqual({ s: 0n, c: 2 });
  });

  it('повторный вебхук об успехе ничего не задваивает', async () => {
    const a = await account('A');
    const id = (await deposit(5000)).json().id;
    await resolveAttempt(pool, id, { status: 'success' });
    await resolveAttempt(pool, id, { status: 'success' });
    await resolveAttempt(pool, id, { status: 'declined' });
    expect(await usage(a)).toEqual({ used: 5000n, reserved: 0n });
    expect((await txRow(id)).status).toBe('success');
    expect((await pool.query(`SELECT count(*)::int c FROM ledger_entries`)).rows[0].c).toBe(2);
  });

  it('игрок «прилипает» к аккаунту, где прошёл платёж', async () => {
    const pricey = await account('Дорогой', { fee: 500 });
    const cheap = await account('Дешёвый', { fee: 100, max: 4000 });
    // первый депозит 5000 не влезает в дешёвый по max → дорогой
    const id = (await deposit(5000)).json().id;
    expect((await txRow(id)).merchant_account_id).toBe(pricey);
    await resolveAttempt(pool, id, { status: 'success' });
    // следующий 1000 влез бы в дешёвый, но игрок остаётся на своём
    const id2 = (await deposit(1000)).json().id;
    expect((await txRow(id2)).merchant_account_id).toBe(pricey);
    // другой игрок идёт на дешёвый
    expect((await txRow((await deposit(1000, { id: 'p2' })).json().id)).merchant_account_id).toBe(cheap);
  });

  it('каскад: отказ провайдера → следующий аккаунт, резерв переносится', async () => {
    const a = await account('A', { fee: 100 });
    const b = await account('B', { fee: 200 });
    const id = (await deposit(5000)).json().id;
    const tx = await resolveAttempt(pool, id, { status: 'declined', error: 'do_not_honor' });
    expect(tx.status).toBe('pending');
    expect(tx.merchantAccountId).toBe(b);
    expect(await usage(a)).toEqual({ used: 0n, reserved: 0n });
    expect(await usage(b)).toEqual({ used: 0n, reserved: 5000n });
    const attempts = (await pool.query(`SELECT attempt_no, status, route_reason FROM transaction_attempts
      WHERE transaction_id = $1 ORDER BY attempt_no`, [id])).rows;
    expect(attempts.map((r) => r.status)).toEqual(['declined', 'pending']);
    expect(attempts[1].route_reason).toMatch(/каскад/);
  });

  it('каскад останавливается после max_attempts', async () => {
    const accs = [await account('A', { fee: 100 }), await account('B', { fee: 200 }), await account('C', { fee: 300 }), await account('D', { fee: 400 })];
    const id = (await deposit(5000)).json().id;
    await resolveAttempt(pool, id, { status: 'declined' });
    await resolveAttempt(pool, id, { status: 'declined' });
    const tx = await resolveAttempt(pool, id, { status: 'declined' });
    expect(tx).toMatchObject({ status: 'declined', declineCode: 'all_attempts_failed' });
    for (const a of accs) expect((await usage(a)).reserved).toBe(0n);
    expect((await pool.query(`SELECT count(*)::int c FROM transaction_attempts WHERE transaction_id = $1`, [id])).rows[0].c).toBe(3);
  });

  // ---------- параллельность ----------

  it('40 параллельных депозитов не переполняют аккаунт', async () => {
    const a = await account('A', { cap: 2000 }); // порог 1 900 → ровно 19 платежей по 100
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => deposit(100, { id: `par-${i}` })));
    const statuses = rs.map((r) => r.json().status);
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(19);
    expect(statuses.filter((s) => s === 'declined')).toHaveLength(21);
    expect(await usage(a)).toEqual({ used: 0n, reserved: 1900n });
  });

  it('параллельные депозиты одного игрока не обходят его лимит', async () => {
    await account('A');
    const rs = await Promise.all(Array.from({ length: 10 }, () => deposit(3000, { id: 'greedy', depositLimitDaily: 10_000 })));
    expect(rs.filter((r) => r.json().status === 'pending')).toHaveLength(3);
  });

  it('ограничение частоты: лишние запросы получают 429', async () => {
    await account('A');
    const limited = buildApp({ ...deps(), rateLimitPerMinute: 3 });
    const call = () => limited.inject({ method: 'GET', url: '/v1/deposits/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${key}` } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call()).statusCode);
    expect(codes).toEqual([404, 404, 404, 429]);
    await limited.close();
  });

  // ---------- чтение ----------

  it('GET отдаёт свой платёж и не отдаёт чужой', async () => {
    await account('A');
    const id = (await deposit(5000)).json().id;
    const own = await app.inject({ method: 'GET', url: `/v1/deposits/${id}`, headers: { authorization: `Bearer ${key}` } });
    expect(own.statusCode).toBe(200);
    expect(own.json().id).toBe(id);
    const foreign = await app.inject({ method: 'GET', url: `/v1/deposits/${id}`, headers: { authorization: `Bearer ${otherKey}` } });
    expect(foreign.statusCode).toBe(404);
    const garbage = await app.inject({ method: 'GET', url: `/v1/deposits/not-a-uuid`, headers: { authorization: `Bearer ${key}` } });
    expect(garbage.statusCode).toBe(404);
  });

  it('ответ не раскрывает, через какой аккаунт пошёл платёж', async () => {
    await account('A');
    const body = (await deposit(5000)).json();
    expect(Object.keys(body).sort()).toEqual(['amount', 'createdAt', 'currency', 'declineCode', 'id', 'paymentUrl', 'status', 'type', 'updatedAt']);
  });
});
