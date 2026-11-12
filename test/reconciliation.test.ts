// Сверка по выписке провайдера и чарджбэки. Сквозной сценарий через учебного провайдера TestPay.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { hashPassword, totpAt, totpStep } from '../src/admin/security.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { TestPayAdapter, TestPaySimulator } from '../src/providers/testpay.js';
import { MapSecretStore } from '../src/secrets.js';
import { autoMapping, parseAmount, parseCsv } from '../src/reports/csv.js';
import { stuckMoney, paymentTimeline } from '../src/admin/insight.js';

const url = process.env.TEST_DATABASE_URL;

describe('разбор CSV выписки', () => {
  it('разделитель, кавычки, BOM, пустые строки', () => {
    const r = parseCsv('﻿Order Code;Amount;Note\r\n123;"1 234,56";"a;b ""c"""\r\n\r\n456;7,5;x\n');
    expect(r.headers).toEqual(['Order Code', 'Amount', 'Note']);
    expect(r.rows).toEqual([['123', '1 234,56', 'a;b "c"'], ['456', '7,5', 'x']]);
  });
  it('суммы в разных форматах', () => {
    expect(parseAmount('1,234.56', 'major')).toBe(123456n);
    expect(parseAmount('1.234,56', 'major')).toBe(123456n);
    expect(parseAmount('-15.00', 'major')).toBe(1500n);
    expect(parseAmount('12,5', 'major')).toBe(1250n);
    expect(parseAmount('1,234', 'major')).toBe(123400n);
    expect(parseAmount('€ 25', 'major')).toBe(2500n);
    expect(parseAmount('1050', 'minor')).toBe(1050n);
    expect(parseAmount('abc', 'major')).toBeNull();
  });
  it('колонки узнаются по названиям', () => {
    expect(autoMapping(['Transaction ID', 'Order Code', 'Transaction Type', 'Status', 'Amount', 'Currency Code', 'Commission', 'InsDate']))
      .toMatchObject({ ref: 'Order Code', operationId: 'Transaction ID', type: 'Transaction Type', amount: 'Amount',
        currency: 'Currency Code', fee: 'Commission', date: 'InsDate', caseRef: null });
  });
});

describe.skipIf(!url)('Сверка и чарджбэки', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let sim: TestPaySimulator;
  let siteKey: string;
  let cookie: string;
  let acc: string;
  let apiKey: string;
  let n = 0;
  const ENC = Buffer.alloc(32, 4);

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE report_lines, report_imports, report_mappings, chargeback_events, chargebacks, audit_log, admin_sessions, admin_users,
      notifications_sent, player_restriction_events, payout_legs, reconciliation_issues, webhook_deliveries, provider_webhook_log,
      provider_webhook_events, ledger_entries, transaction_attempts, transactions, account_usage, players, merchant_accounts, sites, providers, operators CASCADE`);
    const op = (await pool.query(`INSERT INTO operators (name, licenses, payout_kyc_required, platform_fee_bps) VALUES ('Lucky', '{MT}', false, 150) RETURNING id`)).rows[0].id;
    const k = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'casino', $2)`, [op, k.hash]);
    siteKey = k.key;
    sim = new TestPaySimulator('https://pay.test');
    await app?.close();
    app = buildApp({ pool, testpay: sim, providers: new ProviderRegistry().register(new TestPayAdapter(sim)), secrets: new MapSecretStore({}),
      rateLimitPerMinute: 100000, admin: { encryptionKey: ENC, secureCookies: false, loginRateLimitPerMinute: 100000, webhookBaseUrl: 'https://h.test' } });
    sim.deliver = async (u, headers, body) => { const x = new URL(u); return (await app.inject({ method: 'POST', url: x.pathname + x.search, headers, payload: body })).statusCode; };
    await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ('a@x.io', $1, 'admin', false)`, [await hashPassword('pass word 12345')]);
    const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: 'pass word 12345' } });
    const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: totpAt(r1.json().totpSecret, totpStep()) },
      cookies: { ftech_admin: (r1.cookies as { name: string; value: string }[])[0]!.value } });
    cookie = (r2.cookies as { name: string; value: string }[])[0]!.value;
    // Подключаем аккаунт TestPay через борду, как человек.
    acc = (await call('POST', '/admin/v1/connections/accounts', { operatorId: op, adapter: 'testpay', name: 'TestPay EUR', currencies: ['EUR'],
      countries: ['MT'], minAmount: 100, maxAmount: 1000000, dailyCap: 10000000, feeBps: 190 })).json().id;
    apiKey = sim.createKey();
    const hook = (await call('GET', `/admin/v1/accounts/${acc}/connection`)).json().webhook.url;
    const ep = sim.setEndpoint(apiKey, hook);
    await call('PUT', `/admin/v1/accounts/${acc}/credentials`, { values: { apiKey, webhookSecret: ep.secret } });
    await call('PATCH', `/admin/v1/accounts/${acc}`, { enabled: true });
  });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: object) =>
    app.inject({ method, url: path, payload: method === 'GET' ? undefined : (payload ?? {}), cookies: { ftech_admin: cookie } });
  const deposit = async (amount: number, player = 'p1') => (await app.inject({ method: 'POST', url: '/v1/deposits',
    headers: { authorization: `Bearer ${siteKey}`, 'idempotency-key': `dep-${++n}-xxxxxx` },
    payload: { amount, currency: 'EUR', player: { id: player, country: 'MT' } } })).json();
  const paid = async (amount: number, player = 'p1') => {
    const d = await deposit(amount, player);
    const ref = d.paymentUrl.split('/').pop();
    await sim.complete(ref, 'success');
    return { id: d.id as string, ref: ref as string };
  };
  const ledgerBalanced = async () => (await pool.query(`SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount) <> 0`)).rows.length === 0;
  const importCsv = async (csv: string) => {
    const pv = (await call('POST', '/admin/v1/reports/preview', { accountId: acc, filename: 'testpay.csv', csv })).json();
    return { pv, res: await call('POST', '/admin/v1/reports/import', { accountId: acc, filename: 'testpay.csv', csv, mapping: pv.mapping, amountUnit: pv.amountUnit }) };
  };

  it('выписка совпадает с нами: всё зелёное, комиссия сходится, колонки запоминаются', async () => {
    await paid(10000); await paid(2500);
    const d = await deposit(700); await sim.complete(d.paymentUrl.split('/').pop(), 'declined');
    const { pv, res } = await importCsv(sim.reportCsv());
    expect(pv).toMatchObject({ rowCount: 3, remembered: false, mapping: { ref: 'Payment ID', amount: 'Amount', caseRef: 'Case ID' } });
    expect(pv.sample[0]).toMatchObject({ kind: 'payment', status: 'success', amount: '10000', currency: 'EUR', fee: '190' });
    expect(res.statusCode).toBe(201);
    expect(res.json().summary).toMatchObject({ rows: 3, ok: 2, info: 1, warn: 0, bad: 0, matchedPayments: '12500',
      fees: { report: '237', ours: '237', diff: '0' } });
    expect((await call('POST', '/admin/v1/reports/preview', { accountId: acc, filename: 'x.csv', csv: sim.reportCsv() })).json().remembered).toBe(true);
  });

  it('расхождения: не зачислено у нас, неизвестный платёж, лишний возврат, нет в выписке', async () => {
    const a = await paid(5000);
    // Вебхук до нас не дошёл и сверка ещё не прошла: у провайдера оплачено, у нас ждёт.
    const d = await deposit(3000); const deliver = sim.deliver; sim.deliver = null;
    await sim.complete(d.paymentUrl.split('/').pop(), 'success'); sim.deliver = deliver;
    // Наш успешный платёж, которого нет в выписке (выписка выгружена раньше).
    const b = await paid(4000);
    const csv = sim.reportCsv().split('\n').filter((l) => !l.includes(b.ref)).join('\n')
      + `tp_op_x,tp_pay_unknown,payment,completed,12.00,EUR,0.23,${new Date().toISOString()},,\n`
      + `tp_re_x,${a.ref},refund,completed,-10.00,EUR,0.00,${new Date().toISOString()},,\n`;
    const r = (await importCsv(csv)).res.json();
    expect(r.summary).toMatchObject({ bad: 3, warn: 1 });
    const lines = (await call('GET', `/admin/v1/reports/${r.id}`)).json().lines;
    const by = (res: string) => lines.filter((l: { result: string }) => l.result === res);
    expect(by('not_credited')[0]).toMatchObject({ transaction_id: d.id, severity: 'bad' });
    expect(by('unknown_to_us')[0]).toMatchObject({ provider_ref: 'tp_pay_unknown' });
    expect(by('refund_unknown')).toHaveLength(1);
    expect(by('missing_in_report')[0]).toMatchObject({ transaction_id: b.id, severity: 'warn', line_no: null });
    // Видно в «Зависших деньгах»; разобранное оттуда уходит.
    expect((await stuckMoney(pool)).categories.find((c) => c.key === 'report_discrepancies')!.count).toBe(3);
    const line = by('unknown_to_us')[0].id;
    expect((await call('POST', `/admin/v1/reports/lines/${line}/resolve`, { note: 'провайдер подтвердил тестовую операцию' })).statusCode).toBe(200);
    expect((await stuckMoney(pool)).categories.find((c) => c.key === 'report_discrepancies')!.count).toBe(2);
  });

  it('чарджбэк из выписки: заводится один раз, проводки, нельзя вернуть игроку, выиграли — снова можно', async () => {
    const a = await paid(5000);
    sim.dispute(a.ref);
    const r1 = (await importCsv(sim.reportCsv())).res.json();
    expect(r1.summary).toMatchObject({ warn: 1, bad: 0 });
    const r2 = (await importCsv(sim.reportCsv())).res.json(); // та же выписка ещё раз
    expect(r2.summary.warn).toBe(0);
    const cbs = (await call('GET', '/admin/v1/chargebacks')).json();
    expect(cbs).toHaveLength(1);
    expect(cbs[0]).toMatchObject({ amount: '5000', fee: '0', status: 'open', reason_code: '10.4', source: 'report', transaction_id: a.id });
    expect(cbs[0].case_ref).toMatch(/^CB-/);
    expect(await ledgerBalanced()).toBe(true);
    const merchant = async () => (await pool.query(`SELECT coalesce(sum(amount),0)::bigint s FROM ledger_entries WHERE account = 'merchant:' || $1`, [acc])).rows[0].s;
    expect(await merchant()).toBe(0n); // +5000 оплата, −5000 списано эквайером

    // Выплата игроку: оспоренный депозит на карту не возвращается — всё уходит в ручную.
    const po = (await app.inject({ method: 'POST', url: '/v1/payouts', headers: { authorization: `Bearer ${siteKey}`, 'idempotency-key': 'po-cb-00001' },
      payload: { amount: 2000, currency: 'EUR', withdrawalId: 'W-cb', player: { id: 'p1' } } })).json();
    expect(po).toMatchObject({ refundAmount: '0', manualAmount: '2000' });

    const t = (await paymentTimeline(pool, a.id))!;
    expect(t.state.title).toBe('Оспорен (чарджбэк)');
    expect(t.next[0]).toMatchObject({ tab: 'chargebacks' });

    expect((await call('POST', `/admin/v1/chargebacks/${cbs[0].id}/status`, { status: 'evidence_submitted', note: 'логи входа и KYC' })).statusCode).toBe(200);
    expect((await call('POST', `/admin/v1/chargebacks/${cbs[0].id}/status`, { status: 'accepted' })).statusCode).toBe(409); // после доказательств — только won/lost
    expect((await call('POST', `/admin/v1/chargebacks/${cbs[0].id}/status`, { status: 'won' })).statusCode).toBe(200);
    expect(await merchant()).toBe(5000n);
    expect((await pool.query(`SELECT charged_back_amount FROM transactions WHERE id = $1`, [a.id])).rows[0].charged_back_amount).toBe(0n);
    expect(await ledgerBalanced()).toBe(true);
    const hist = (await call('GET', '/admin/v1/chargebacks?all=true')).json()[0].history.map((h: { status: string }) => h.status);
    expect(hist).toEqual(['open', 'evidence_submitted', 'won']);
  });

  it('чарджбэк вручную: сумма не больше невозвращённой части; проиграли — потеря в проводках', async () => {
    const a = await paid(5000);
    const big = await call('POST', '/admin/v1/chargebacks', { transactionId: a.id, amount: 6000 });
    expect(big.statusCode).toBe(409);
    const ok = await call('POST', '/admin/v1/chargebacks', { transactionId: a.id, amount: 5000, fee: 1500, caseRef: 'CASE-1', reasonCode: '4837',
      respondBy: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) });
    expect(ok.statusCode).toBe(201);
    expect((await call('POST', '/admin/v1/chargebacks', { transactionId: a.id, amount: 1000, caseRef: 'CASE-1' })).statusCode).toBe(409);
    // Срок ответа завтра — в «Зависших деньгах» как требующий действия.
    expect((await stuckMoney(pool)).categories.find((c) => c.key === 'chargeback_deadline')!.count).toBe(1);
    await call('POST', `/admin/v1/chargebacks/${ok.json().id}/status`, { status: 'lost' });
    const loss = (await pool.query(`SELECT sum(amount)::bigint s FROM ledger_entries WHERE account LIKE 'chargeback_loss:%'`)).rows[0].s;
    expect(loss).toBe(5000n);
    const fees = (await pool.query(`SELECT sum(amount)::bigint s FROM ledger_entries WHERE account LIKE 'provider_fees:%'`)).rows[0].s;
    expect(fees).toBe(1500n);
    expect(await ledgerBalanced()).toBe(true);
    expect((await stuckMoney(pool)).categories.find((c) => c.key === 'chargeback_deadline')!.count).toBe(0);
  });

  it('без колонок ID и суммы импорт не начинается; чужой роли — нельзя', async () => {
    const r = await call('POST', '/admin/v1/reports/import', { accountId: acc, filename: 'x.csv', csv: 'a,b\n1,2\n', mapping: { ref: null, amount: 'b' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('mapping_required');
    expect((await app.inject({ method: 'POST', url: '/admin/v1/reports/import', payload: {} })).statusCode).toBe(401);
  });
});
