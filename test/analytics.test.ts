// Аналитика: разбивка по операторам/сайтам/аккаунтам/провайдерам, свой период, выгрузки CSV.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, totpAt, totpStep } from '../src/admin/security.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { csvCell, csvMoney } from '../src/admin/analytics.js';

const url = process.env.TEST_DATABASE_URL;

describe('CSV-помощники', () => {
  it('экранирует формулы и разделители', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+380')).toBe(`'+380`);
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('обычный')).toBe('обычный');
    expect(csvCell(null)).toBe('');
  });
  it('суммы из копеек', () => {
    expect(csvMoney(123456n, 'comma')).toBe('1234,56');
    expect(csvMoney(5n, 'dot')).toBe('0.05');
  });
});

describe.skipIf(!url)('Аналитика', () => {
  let pool: Pool;
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  let opA: string, opB: string, siteA: string, siteB: string, accVivaA: string;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    const mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    app = buildApp({ pool, mock, providers: new ProviderRegistry().register(new MockAdapter(mock)),
      secrets: new MapSecretStore({}), rateLimitPerMinute: 100000,
      admin: { encryptionKey: Buffer.alloc(32, 7), secureCookies: false, loginRateLimitPerMinute: 100000 } });

    const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0]?.id as string;
    opA = await q(`INSERT INTO operators (name, platform_fee_bps) VALUES ('Lucky Ltd', 150) RETURNING id`);
    opB = await q(`INSERT INTO operators (name, platform_fee_bps) VALUES ('Spin Co', 100) RETURNING id`);
    siteA = await q(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'lucky.com', 'h1') RETURNING id`, [opA]);
    siteB = await q(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'spin.io', 'h2') RETURNING id`, [opB]);
    const viva = await q(`INSERT INTO providers (code, name, adapter) VALUES ('viva', 'Viva Wallet', 'viva') RETURNING id`);
    const mockP = await q(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Тест', 'mock') RETURNING id`);
    const acc = (op: string, prov: string, name: string) => q(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap)
       VALUES ($1, $2, $3, '{EUR}', '{MT}', 100, 1000000, 10000000) RETURNING id`, [op, prov, name]);
    accVivaA = await acc(opA, viva, 'Viva A');
    const accMockA = await acc(opA, mockP, 'Mock A');
    const accVivaB = await acc(opB, viva, 'Viva B');
    const plA = await q(`INSERT INTO players (site_id, external_id, country) VALUES ($1, '=cmd|evil', 'MT') RETURNING id`, [siteA]);
    const plB = await q(`INSERT INTO players (site_id, external_id, country) VALUES ($1, 'p2', 'MT') RETURNING id`, [siteB]);

    let n = 0;
    const tx = async (site: string, pl: string, type: string, status: string, amount: number, account: string | null,
      attempts: [string, string][], when = 'now()', fee = 0) => {
      const id = await q(`INSERT INTO transactions (site_id, player_id, type, amount, currency, status, merchant_account_id,
          idempotency_key, platform_fee, provider_fee, created_at)
        VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $7, $8, $9, ${when}) RETURNING id`,
        [site, pl, type, amount, status, account, `k-${++n}-xxxxxxxx`, status === 'success' ? fee : null, status === 'success' ? 10 : null]);
      for (const [i, [a, s]] of attempts.entries()) {
        await pool.query(`INSERT INTO transaction_attempts (transaction_id, merchant_account_id, status, route_reason, attempt_no)
          VALUES ($1, $2, $3, 'test', $4)`, [id, a, s, i + 1]);
      }
      return id;
    };
    // Lucky: 2 успешных через Viva A (один — после отказа Mock A), 1 отказ.
    await tx(siteA, plA, 'deposit', 'success', 10000, accVivaA, [[accVivaA, 'success']], 'now()', 150);
    await tx(siteA, plA, 'deposit', 'success', 5000, accVivaA, [[accMockA, 'declined'], [accVivaA, 'success']], 'now()', 75);
    await tx(siteA, plA, 'deposit', 'declined', 2000, accMockA, [[accMockA, 'declined']]);
    // Spin: 1 успешный.
    await tx(siteB, plB, 'deposit', 'success', 40000, accVivaB, [[accVivaB, 'success']], 'now()', 400);
    // Старый платёж — за пределами 7 дней.
    await tx(siteA, plA, 'deposit', 'success', 99900, accVivaA, [[accVivaA, 'success']], `now() - interval '40 days'`, 999);
    // Выплата Lucky: 3000 возвратом через Viva A.
    const payout = await tx(siteA, plA, 'payout', 'success', 3000, null, []);
    await pool.query(`INSERT INTO payout_legs (payout_id, kind, deposit_id, merchant_account_id, amount, status)
      SELECT $1, 'refund', id, $2, 3000, 'success' FROM transactions WHERE amount = 10000`, [payout, accVivaA]);

    for (const [email, role] of [['admin@x.io', 'admin'], ['view@x.io', 'viewer']] as const) {
      await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ($1, $2, $3, false)`,
        [email, await hashPassword('pass word 12345'), role]);
      const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email, password: 'pass word 12345' } });
      const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: totpAt(r1.json().totpSecret, totpStep()) },
        cookies: { ftech_admin: (r1.cookies as { name: string; value: string }[])[0]!.value } });
      cookies[role] = (r2.cookies as { name: string; value: string }[])[0]!.value;
    }
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  const get = (path: string, role = 'admin') => app.inject({ method: 'GET', url: path, cookies: { ftech_admin: cookies[role]! } });

  it('по операторам: оборот, конверсия, заработок, выплаты; итог', async () => {
    const r = (await get('/admin/v1/analytics?period=7d&groupBy=operator&tz=Europe/Kyiv')).json();
    const lucky = r.rows.find((x: { label: string }) => x.label === 'Lucky Ltd');
    expect(lucky).toMatchObject({ currency: 'EUR', deposits: 3, succeeded: 2, declined: 1, volume: '15000', earned: '225',
      attempts: 4, attemptsOk: 2, payouts: 1, paidOut: '3000', providerCost: '20' });
    expect(r.rows[0].label).toBe('Spin Co'); // больше оборот — выше
    expect(r.totals).toEqual([expect.objectContaining({ label: 'Итого', volume: '55000', deposits: 4, earned: '625' })]);
  });

  it('по аккаунтам: попытки считаются по аккаунту попытки, выплаты — возвраты через аккаунт', async () => {
    const r = (await get('/admin/v1/analytics?period=7d&groupBy=account')).json();
    const by = (l: string) => r.rows.find((x: { label: string }) => x.label === l);
    expect(by('Viva A')).toMatchObject({ extra: 'Viva Wallet', succeeded: 2, attempts: 2, attemptsOk: 2, paidOut: '3000' });
    expect(by('Mock A')).toMatchObject({ deposits: 1, declined: 1, attempts: 2, attemptsOk: 0 });
  });

  it('по провайдерам и фильтр по оператору', async () => {
    const r = (await get(`/admin/v1/analytics?period=7d&groupBy=provider&operatorId=${opB}`)).json();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ label: 'Viva Wallet', volume: '40000' });
    const sites = (await get('/admin/v1/analytics?period=30d&groupBy=site')).json();
    expect(sites.rows.map((x: { label: string; extra: string }) => `${x.label}/${x.extra}`).sort()).toEqual(['lucky.com/Lucky Ltd', 'spin.io/Spin Co']);
  });

  it('свой период включает старые платежи и проверяет границы', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 60 * 86400e3).toISOString().slice(0, 10);
    const r = (await get(`/admin/v1/analytics?period=custom&from=${old}&to=${today}`)).json();
    expect(r.totals[0].volume).toBe(String(55000 + 99900));
    expect(r.fromDay).toBe(old);
    expect((await get(`/admin/v1/analytics?period=custom&from=${today}&to=${old}`)).statusCode).toBe(400);
    expect((await get(`/admin/v1/analytics?period=custom&from=2020-01-01&to=${today}`)).statusCode).toBe(400);
  });

  it('CSV сводки: BOM, «;», дробь через запятую, итог', async () => {
    const r = await get('/admin/v1/analytics.csv?period=7d&groupBy=site', 'viewer');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="ftech-summary-site-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^Сайт;Оператор;Валюта;Депозитов/);
    expect(lines.find((l) => l.startsWith('lucky.com'))).toContain(';150,00;');
    expect(lines.at(-1)).toMatch(/^Итого;;EUR;4;3;1;0;75,0;/);
    const dot = await get('/admin/v1/analytics.csv?period=7d&groupBy=site&decimal=dot');
    expect(dot.body).toContain(',150.00,');
  });

  it('выгрузка платежей: только с роли оператора, пишется в журнал, ID игрока экранирован', async () => {
    expect((await get('/admin/v1/export/transactions.csv?period=7d', 'viewer')).statusCode).toBe(403);
    const r = await get('/admin/v1/export/transactions.csv?period=7d&tz=Europe/Kyiv');
    expect(r.statusCode).toBe(200);
    const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(1 + 5);
    expect(lines[0]).toContain('Дата (Europe/');
    expect(r.body).toContain(`'=cmd|evil`);
    expect(r.body).toContain('выплата;успешно');
    const log = (await pool.query(`SELECT after FROM audit_log WHERE action = 'export.transactions'`)).rows;
    expect(log).toHaveLength(1);
    expect(log[0].after.rows).toBe(5);
  });

  it('без входа — 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/v1/analytics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/v1/export/transactions.csv' })).statusCode).toBe(401);
  });
});
