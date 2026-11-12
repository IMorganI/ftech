// Выплаты по closed loop: возвраты на карты депозитов, остаток — ручная выплата.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { hashPassword, totpAt, totpStep } from '../src/admin/security.js';
import { ProviderRegistry, type ProviderAdapter } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { resolveAttempt } from '../src/routing/router.js';
import { completeManualLeg } from '../src/payouts/payouts.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Выплаты', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let mock: MockProvider;
  let providers: ProviderRegistry;
  let key: string;
  let op: string;
  let accA: string;
  let accB: string;
  let n = 0;
  const secrets = new MapSecretStore({ MOCK: 's' });

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE audit_log, admin_sessions, admin_users, payout_legs, reconciliation_issues, webhook_deliveries,
      provider_webhook_events, ledger_entries, transaction_attempts, transactions, account_usage, players, merchant_accounts,
      sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses) VALUES ('Op', '{MT}') RETURNING id`)).rows[0].id;
    const k = generateApiKey(); key = k.key;
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash, webhook_url, webhook_secret_enc) VALUES ($1, 'casino', $2, 'https://x', 'v1.a.b.c')`, [op, k.hash]);
    const prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;
    const acc = async (name: string, fee: number) => (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, credentials_ref)
       VALUES ($1, $2, $3, '{EUR}', '{MT}', 100, 1000000, 100000000, $4, 'MOCK') RETURNING id`, [op, prov, name, fee])).rows[0].id as string;
    accA = await acc('A', 100); accB = await acc('B', 200);
    mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    providers = new ProviderRegistry().register(new MockAdapter(mock));
    await app?.close();
    app = buildApp({ pool, providers, secrets, mock, rateLimitPerMinute: 100000,
      admin: { encryptionKey: Buffer.alloc(32, 3), secureCookies: false, loginRateLimitPerMinute: 100000 } });
  });

  const post = (path: string, payload: object, idem = `po-${++n}-${Date.now()}`) => app.inject({
    method: 'POST', url: path, headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem }, payload });

  /** Успешный депозит игрока через мок (с оплатой). Можно выключить аккаунт, чтобы депозит ушёл на другой. */
  async function paidDeposit(amount: number, player = 'p1') {
    const d = (await post('/v1/deposits', { amount, currency: 'EUR', player: { id: player, country: 'MT', kyc: 'verified' } })).json();
    await mock.complete(d.paymentUrl.split('/').pop(), 'success');
    await resolveAttempt(pool, d.id, { status: 'success' }).catch(() => {}); // если вебхук уже обработал — ничего
    return d.id as string;
  }
  const payout = (amount: number, player = 'p1', extra: object = {}, idem?: string) =>
    post('/v1/payouts', { amount, currency: 'EUR', withdrawalId: `w-${idem ?? Math.random().toString(36).slice(2)}`, player: { id: player, ...extra } }, idem);
  const refunded = async (id: string) => (await pool.query(`SELECT refunded_amount FROM transactions WHERE id = $1`, [id])).rows[0].refunded_amount;
  const ledgerSum = async (txId: string) => (await pool.query(`SELECT coalesce(sum(amount),0)::bigint s FROM ledger_entries WHERE transaction_id = $1`, [txId])).rows[0].s;

  it('выплата в пределах депозита — возврат на ту же карту, сразу успех', async () => {
    const dep = await paidDeposit(5000);
    const r = await payout(3000);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ type: 'payout', status: 'success', amount: '3000', refundAmount: '3000', manualAmount: '0' });
    expect(await refunded(dep)).toBe(3000n);
    const p = [...mock.payments.values()][0]!;
    expect(p.refunded).toBe(3000n);
    expect(await ledgerSum(r.json().id)).toBe(0n);
    const ev = (await pool.query(`SELECT event FROM webhook_deliveries WHERE transaction_id = $1`, [r.json().id])).rows.map((x) => x.event);
    expect(ev).toEqual(['payout.succeeded']);
  });

  it('выплата больше депозитов — возвраты по всем депозитам, остаток ручной', async () => {
    const d1 = await paidDeposit(2000);
    await pool.query(`UPDATE merchant_accounts SET enabled = false WHERE id = $1`, [accA]);
    const d2 = await paidDeposit(3000); // пошёл через B
    const r = (await payout(8000)).json();
    expect(r).toMatchObject({ status: 'pending', refundAmount: '5000', manualAmount: '3000' });
    expect(r.parts.map((x: { kind: string; amount: string; status: string }) => `${x.kind}:${x.amount}:${x.status}`).sort())
      .toEqual(['manual:3000:pending', 'refund:2000:success', 'refund:3000:success']);
    expect(await refunded(d1)).toBe(2000n);
    expect(await refunded(d2)).toBe(3000n);
    const ev = (await pool.query(`SELECT event FROM webhook_deliveries WHERE transaction_id = $1`, [r.id])).rows.map((x) => x.event);
    expect(ev).toEqual(['payout.requires_manual']);
  });

  it('оператор отмечает ручную выплату — выплата завершается, проводки сходятся', async () => {
    await paidDeposit(1000);
    const r = (await payout(4000)).json();
    const leg = (await pool.query(`SELECT id FROM payout_legs WHERE payout_id = $1 AND kind = 'manual'`, [r.id])).rows[0].id;
    await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ('o@x.io', 'x', 'operator', false)`);
    const admin = (await pool.query(`SELECT id FROM admin_users`)).rows[0].id;
    const tx = await completeManualLeg(pool, leg, { userId: admin }, { reference: 'SEPA №123', note: '' });
    expect(tx!.status).toBe('success');
    expect(await ledgerSum(r.id)).toBe(0n);
    const entries = (await pool.query(`SELECT account, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`, [r.id])).rows;
    expect(entries.map((e) => `${e.account.split(':')[0]}:${e.amount}`)).toEqual(['merchant:-1000', 'player:1000', 'manual:-3000', 'player:3000']);
    await expect(completeManualLeg(pool, leg, { userId: admin }, { reference: 'ещё раз', note: '' })).rejects.toThrow(/не найдена/); // повторно не отмечается
  });

  it('повторные выплаты не возвращают депозит больше его суммы', async () => {
    const dep = await paidDeposit(5000);
    expect((await payout(4000)).json().refundAmount).toBe('4000');
    expect((await payout(4000)).json()).toMatchObject({ refundAmount: '1000', manualAmount: '3000' });
    expect(await refunded(dep)).toBe(5000n);
  });

  it('параллельные выплаты не возвращают один депозит дважды', async () => {
    const dep = await paidDeposit(5000);
    const rs = await Promise.all(Array.from({ length: 6 }, () => payout(2000)));
    const totalRefund = rs.reduce((a, r) => a + BigInt(r.json().refundAmount), 0n);
    expect(totalRefund).toBe(5000n);
    expect(await refunded(dep)).toBe(5000n);
    expect([...mock.payments.values()][0]!.refunded).toBe(5000n);
  });

  it('провайдер отказал в возврате — резерв снят, сумма уходит в ручную выплату', async () => {
    const dep = await paidDeposit(5000);
    mock = Object.assign(mock, {}); // тот же мок
    (mock as unknown as { opts: { refundDeclineRate: number } }).opts.refundDeclineRate = 1;
    const r = (await payout(3000)).json();
    expect(r).toMatchObject({ status: 'pending', refundAmount: '0', manualAmount: '3000' });
    expect(await refunded(dep)).toBe(0n);
    const legs = (await pool.query(`SELECT kind, status, error, note FROM payout_legs WHERE payout_id = $1 ORDER BY created_at`, [r.id])).rows;
    expect(legs[0]).toMatchObject({ kind: 'refund', status: 'failed' });
    expect(legs[1].note).toMatch(/вместо возврата/);
  });

  it('нет ответа провайдера при возврате — не повторяем, создаём проблему для проверки', async () => {
    await paidDeposit(5000);
    const real = new MockAdapter(mock);
    const broken: ProviderAdapter = { ...real, name: 'mock', createPayment: real.createPayment.bind(real), getStatus: real.getStatus.bind(real),
      verifyWebhook: real.verifyWebhook.bind(real), refund: async () => { throw new Error('ETIMEDOUT'); } };
    providers.register(broken);
    const r = (await payout(3000)).json();
    expect(r.status).toBe('pending');
    const issue = (await pool.query(`SELECT kind, details FROM reconciliation_issues`)).rows[0];
    expect(issue.kind).toBe('refund_unknown');
    expect(issue.details).toMatch(/ETIMEDOUT/);
    // Резерв остаётся: деньги могли уйти
    expect((await pool.query(`SELECT sum(refunded_amount)::bigint s FROM transactions WHERE type = 'deposit'`)).rows[0].s).toBe(3000n);
  });

  it('без KYC выплата отклоняется; KYC можно подтвердить в запросе', async () => {
    await paidDeposit(5000);
    await pool.query(`UPDATE players SET kyc = 'pending'`);
    expect((await payout(1000)).json()).toMatchObject({ status: 'declined', declineCode: 'kyc_required' });
    expect((await payout(1000, 'p1', { kyc: 'verified' })).json().status).toBe('success');
  });

  it('неизвестный игрок — 422, идемпотентность как у депозитов', async () => {
    expect((await payout(1000, 'ghost')).statusCode).toBe(422);
    await paidDeposit(5000);
    const a = await payout(1000, 'p1', {}, 'same-payout-key');
    const b = await payout(1000, 'p1', {}, 'same-payout-key');
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect((await payout(2000, 'p1', {}, 'same-payout-key')).statusCode).toBe(409);
    expect([...mock.payments.values()][0]!.refunded).toBe(1000n);
  });

  it('выплаты и депозиты не смешиваются в API', async () => {
    const dep = await paidDeposit(5000);
    const po = (await payout(1000)).json();
    const get = (p: string) => app.inject({ method: 'GET', url: p, headers: { authorization: `Bearer ${key}` } });
    expect((await get(`/v1/payouts/${po.id}`)).json().refundAmount).toBe('1000');
    expect((await get(`/v1/deposits/${po.id}`)).statusCode).toBe(404);
    expect((await get(`/v1/payouts/${dep}`)).statusCode).toBe(404);
  });

  it('борда: ручные выплаты видны и закрываются оператором с записью в журнал', async () => {
    await paidDeposit(1000);
    const po = (await payout(2500)).json();
    await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ('o@x.io', $1, 'operator', false)`,
      [await hashPassword('pass word 12345')]);
    const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'o@x.io', password: 'pass word 12345' } });
    const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: totpAt(r1.json().totpSecret, totpStep()) },
      cookies: { ftech_admin: (r1.cookies as { name: string; value: string }[])[0]!.value } });
    const cookie = (r2.cookies as { name: string; value: string }[])[0]!.value;
    const list = (await app.inject({ method: 'GET', url: '/admin/v1/manual-payouts', cookies: { ftech_admin: cookie } })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amount: '1500', player: 'p1', site: 'casino' });
    const done = await app.inject({ method: 'POST', url: `/admin/v1/manual-payouts/${list[0].id}/complete`, payload: { reference: 'SEPA-2026-0001', note: 'Перевод на IBAN игрока' }, cookies: { ftech_admin: cookie } });
    expect(done.json()).toEqual({ ok: true, payoutStatus: 'success' });
    expect((await pool.query(`SELECT action FROM audit_log WHERE action = 'payout.manual_complete'`)).rows).toHaveLength(1);
    const detail = (await app.inject({ method: 'GET', url: `/admin/v1/transactions/${po.id}`, cookies: { ftech_admin: cookie } })).json();
    expect(detail.legs.map((l: { kind: string; status: string }) => `${l.kind}:${l.status}`)).toEqual(['refund:success', 'manual:success']);
  });
});
