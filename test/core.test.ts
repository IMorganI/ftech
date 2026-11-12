// Укрепление платёжного ядра: ограничения игрока, обработка вебхуков, валюты, неизвестная отправка,
// контроль выплат, зачисление только по подтверждённой сумме. Нужна реальная PostgreSQL (TEST_DATABASE_URL).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { processInbox } from '../src/payments/flow.js';
import { approveManualLeg, completeManualLeg } from '../src/payouts/payouts.js';
import type { ProviderAdapter } from '../src/providers/types.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Ядро', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let mock: MockProvider;
  let providers: ProviderRegistry;
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
    await pool.query(`TRUNCATE audit_log, admin_sessions, admin_users, player_restriction_events, payout_legs, reconciliation_issues, webhook_deliveries, provider_webhook_log,
      provider_webhook_events, ledger_entries, transaction_attempts, transactions, account_usage, players, merchant_accounts, sites,
      providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses, kyc_required_above, max_attempts, payout_kyc_required)
      VALUES ('Op', '{MT,DE}', NULL, 3, false) RETURNING id`)).rows[0].id;
    const k = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'S1', $2)`, [op, k.hash]);
    key = k.key;
    prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;
    mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    providers = new ProviderRegistry().register(new MockAdapter(mock));
    await app?.close();
    app = buildApp({ pool, mock, providers, secrets: new MapSecretStore({ MOCK: 'test-secret' }), rateLimitPerMinute: 100000 });
    mock.sink = async (accountId, headers, body) => {
      await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${accountId}`, headers, payload: body });
    };
  });

  async function account(name = 'A', o: { cur?: string; cap?: number } = {}) {
    return (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, credentials_ref)
       VALUES ($1, $2, $3, $4, '{MT,DE}', 100, 1000000, $5, 'MOCK') RETURNING id`,
      [op, prov, name, `{${o.cur ?? 'EUR'}}`, o.cap ?? 1_000_000])).rows[0].id as string;
  }
  const deposit = (amount: number, player: Record<string, unknown> = {}, currency = 'EUR') => app.inject({
    method: 'POST', url: '/v1/deposits',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': `idem-${++n}-${Date.now()}` },
    payload: { amount, currency, player: { id: 'p1', country: 'MT', ...player } },
  });
  const restrictions = (method: 'GET' | 'PUT', body?: object, player = 'p1') => app.inject({
    method, url: `/v1/players/${player}/restrictions`, headers: { authorization: `Bearer ${key}` }, payload: body,
  });
  const events = async () => (await pool.query(
    `SELECT field, old_value, new_value, source FROM player_restriction_events ORDER BY id`)).rows;

  // ---------- 1. ограничения игрока ----------

  describe('ограничения игрока', () => {
    it('самоисключение «залипает»: следующий депозит без поля или с false его не снимает', async () => {
      await account();
      expect((await deposit(1000, { selfExcluded: true })).json().declineCode).toBe('player_self_excluded');
      expect((await deposit(1000)).json().declineCode).toBe('player_self_excluded');
      expect((await deposit(1000, { selfExcluded: false })).json().declineCode).toBe('player_self_excluded');
      expect(await events()).toEqual([{ field: 'self_excluded', old_value: 'false', new_value: 'true', source: 'deposit' }]);
    });

    it('снять самоисключение можно только через API ограничений — с записью в журнал', async () => {
      await account();
      await deposit(1000, { selfExcluded: true });
      const r = await restrictions('PUT', { selfExcluded: false, note: 'истёк срок самоисключения' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ selfExcluded: false, version: 3 });
      expect((await deposit(1000)).json().status).toBe('pending');
      expect((await events()).at(-1)).toEqual({ field: 'self_excluded', old_value: 'true', new_value: 'false', source: 'api' });
    });

    it('лимит: снижение из депозита — сразу; повышение из депозита игнорируется; null его не снимает', async () => {
      await account();
      await deposit(1000, { depositLimitDaily: 5000 });
      await deposit(1000, { depositLimitDaily: 3000 });
      await deposit(500, { depositLimitDaily: 100000 });
      await deposit(500, { depositLimitDaily: null });
      expect((await restrictions('GET')).json()).toMatchObject({ depositLimitDaily: '3000', pendingDepositLimit: null });
      expect((await deposit(1000)).json().declineCode).toBe('player_limit_exceeded'); // 1000+1000+500+500 уже 3000
    });

    it('повышение и снятие лимита через API — только после периода охлаждения', async () => {
      await account();
      await deposit(1000, { depositLimitDaily: 2000 });
      const r = (await restrictions('PUT', { depositLimitDaily: 50000 })).json();
      expect(r.depositLimitDaily).toBe('2000');
      expect(r.pendingDepositLimit.value).toBe('50000');
      expect(new Date(r.pendingDepositLimit.effectiveAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect((await deposit(1500)).json().declineCode).toBe('player_limit_exceeded');
      // Прошло 24 часа.
      await pool.query(`UPDATE players SET deposit_limit_pending_at = now() - interval '1 minute'`);
      expect((await deposit(1500)).json().status).toBe('pending');
      expect((await restrictions('GET')).json()).toMatchObject({ depositLimitDaily: '50000', pendingDepositLimit: null });
      // Снятие лимита — тоже через охлаждение.
      expect((await restrictions('PUT', { depositLimitDaily: null })).json().pendingDepositLimit).toMatchObject({ value: null });
    });

    it('снижение отменяет ожидающее повышение', async () => {
      await account();
      await deposit(500, { depositLimitDaily: 2000 });
      await restrictions('PUT', { depositLimitDaily: 9000 });
      const r = (await restrictions('PUT', { depositLimitDaily: 1000 })).json();
      expect(r).toMatchObject({ depositLimitDaily: '1000', pendingDepositLimit: null });
    });

    it('KYC меняется, только если сайт его прислал', async () => {
      await account();
      await deposit(1000, { kyc: 'verified' });
      await deposit(1000);
      expect((await restrictions('GET')).json().kyc).toBe('verified');
      await deposit(1000, { kyc: 'rejected' });
      expect((await deposit(1000)).json().declineCode).toBe('kyc_rejected');
    });

    it('версия защищает от изменений по устаревшему состоянию', async () => {
      await account();
      await deposit(1000);
      const v = (await restrictions('GET')).json().version;
      expect((await restrictions('PUT', { version: v, depositLimitDaily: 5000 })).statusCode).toBe(200);
      const stale = await restrictions('PUT', { version: v, selfExcluded: false });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('version_conflict');
    });

    it('неизвестный игрок — 404; журнал ограничений нельзя менять', async () => {
      expect((await restrictions('GET', undefined, 'nobody')).statusCode).toBe(404);
      await account();
      await deposit(1000, { selfExcluded: true });
      await expect(pool.query(`DELETE FROM player_restriction_events`)).rejects.toThrow(/не меняются/);
    });

    it('дневной лимит игрока считается по валюте депозита', async () => {
      await account('E');
      await account('U', { cur: 'USD' });
      await deposit(1500, { depositLimitDaily: 2000 });
      expect((await deposit(1500, {}, 'USD')).json().status).toBe('pending');
      expect((await deposit(1500)).json().declineCode).toBe('player_limit_exceeded');
    });
  });

  // ---------- 2. inbox вебхуков ----------

  describe('обработка вебхуков до конца', () => {
    let statusDown = false;
    beforeEach(() => {
      statusDown = false;
      const real = new MockAdapter(mock);
      const flaky: ProviderAdapter = {
        name: 'mock', manifest: real.manifest,
        createPayment: (c, r) => real.createPayment(c, r),
        getPayment: async (c, ref) => { if (statusDown) throw new Error('provider 503'); return real.getPayment(c, ref); },
        verifyWebhook: (c, h, b) => real.verifyWebhook(c, h, b),
      };
      providers.register(flaky);
    });
    const txStatus = async (id: string) => (await pool.query(`SELECT status FROM transactions WHERE id = $1`, [id])).rows[0].status;
    const event = async () => (await pool.query(`SELECT event_id, processed_at, attempts, last_error, result FROM provider_webhook_events`)).rows[0];

    it('упало при обработке — повторная доставка того же события обрабатывает его, а не считает повтором', async () => {
      await account();
      const d = (await deposit(1000)).json();
      const ref = d.paymentUrl.split('/').pop();
      statusDown = true;
      await mock.complete(ref, 'success'); // вебхук пришёл, но провайдер не ответил на запрос статуса
      expect(await txStatus(d.id)).toBe('pending');
      const e1 = await event();
      expect(e1).toMatchObject({ processed_at: null, attempts: 1, last_error: 'provider 503' });

      statusDown = false;
      await mock.sendWebhook(mock.payments.get(ref)!, e1.event_id); // провайдер повторяет то же событие
      expect(await txStatus(d.id)).toBe('success');
      expect(await event()).toMatchObject({ attempts: 2, result: 'processed', last_error: null });

      await mock.sendWebhook(mock.payments.get(ref)!, e1.event_id); // а вот это уже настоящий повтор
      const log = (await pool.query(`SELECT outcome, reason FROM provider_webhook_log ORDER BY id`)).rows.map((r) => r.outcome);
      expect(log).toEqual(['error', 'accepted', 'duplicate']);
    });

    it('если провайдер больше не присылает событие — его дообрабатывает фоновая задача', async () => {
      await account();
      const d = (await deposit(1000)).json();
      statusDown = true;
      await mock.complete(d.paymentUrl.split('/').pop(), 'success');
      statusDown = false;
      expect(await processInbox({ pool, providers, secrets: new MapSecretStore({ MOCK: 'test-secret' }) }, 0)).toEqual({ checked: 1, processed: 1 });
      expect(await txStatus(d.id)).toBe('success');
      expect(await processInbox({ pool, providers, secrets: new MapSecretStore({ MOCK: 'test-secret' }) }, 0)).toEqual({ checked: 0, processed: 0 });
    });
  });

  // ---------- 3. лимиты аккаунта по валютам ----------

  describe('лимиты аккаунта по валютам', () => {
    it('старый мультивалютный аккаунт: лимит в каждой валюте отдельно, суммы не складываются', async () => {
      const acc = (await pool.query(
        `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, switch_at_bps, credentials_ref)
         VALUES ($1, $2, 'multi', '{EUR,USD}', '{MT}', 100, 100000, 10000, 10000, 'MOCK') RETURNING id`, [op, prov])).rows[0].id;
      expect((await deposit(8000)).json().status).toBe('pending');
      expect((await deposit(8000, {}, 'USD')).json().status).toBe('pending'); // раньше: 8000 EUR + 8000 USD > 10000 → отказ
      expect((await deposit(3000)).json().declineCode).toBe('no_route');
      const rows = (await pool.query(`SELECT currency, reserved FROM account_usage WHERE merchant_account_id = $1 ORDER BY currency`, [acc])).rows;
      expect(rows.map((r) => [r.currency, r.reserved])).toEqual([['EUR', 8000n], ['USD', 8000n]]);
    });
  });

  // ---------- 5. контроль выплат ----------

  describe('контроль выплат', () => {
    const payout = (amount: number, withdrawalId: string, idem = `po-${++n}-${Date.now()}`) => app.inject({
      method: 'POST', url: '/v1/payouts', headers: { authorization: `Bearer ${key}`, 'idempotency-key': idem },
      payload: { amount, currency: 'EUR', withdrawalId, player: { id: 'p1' } },
    });
    async function paidDeposit(amount: number) {
      await account();
      const d = (await deposit(amount)).json();
      await mock.complete(d.paymentUrl.split('/').pop(), 'success');
      return d.id as string;
    }
    async function users() {
      const ids: string[] = [];
      for (const e of ['a@x.io', 'b@x.io']) {
        ids.push((await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ($1, 'x', 'operator', false) RETURNING id`, [e])).rows[0].id);
      }
      return ids as [string, string];
    }
    const manualLeg = async (payoutId: string) => (await pool.query(`SELECT id FROM payout_legs WHERE payout_id = $1 AND kind = 'manual'`, [payoutId])).rows[0].id;

    it('withdrawalId обязателен; один вывод — одна выплата, даже с другим Idempotency-Key', async () => {
      await paidDeposit(5000);
      const noId = await app.inject({ method: 'POST', url: '/v1/payouts', headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'po-no-id-1' },
        payload: { amount: 1000, currency: 'EUR', player: { id: 'p1' } } });
      expect(noId.statusCode).toBe(400);
      const first = await payout(1000, 'W-1', 'po-key-0001');
      expect(first.statusCode).toBe(201);
      expect(first.json().withdrawalId).toBe('W-1');
      expect((await payout(1000, 'W-1', 'po-key-0001')).statusCode).toBe(200); // повтор того же запроса
      const dup = await payout(1000, 'W-1', 'po-key-0002');
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toMatchObject({ code: 'duplicate_withdrawal', details: { payoutId: first.json().id } });
      expect((await pool.query(`SELECT count(*)::int c FROM transactions WHERE type = 'payout'`)).rows[0].c).toBe(1);
    });

    it('параллельные запросы одного вывода с разными ключами — ровно одна выплата', async () => {
      await paidDeposit(5000);
      const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => payout(4000, 'W-par', `po-par-000${i}`)));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
      expect((await pool.query(`SELECT sum(refunded_amount)::bigint s FROM transactions WHERE type = 'deposit'`)).rows[0].s).toBe(4000n);
    });

    it('лимит одной выплаты оператора', async () => {
      await pool.query(`UPDATE operators SET payout_max_amount = 2000`);
      await paidDeposit(5000);
      expect((await payout(2500, 'W-big')).json()).toMatchObject({ status: 'declined', declineCode: 'amount_over_limit' });
      expect((await payout(2000, 'W-ok')).json().status).toBe('success');
    });

    it('ручная выплата от порога: одобряет один, отмечает выполненной другой; номер перевода обязателен', async () => {
      await pool.query(`UPDATE operators SET manual_approval_above = 1000`);
      await paidDeposit(1000);
      const po = (await payout(6000, 'W-man')).json();
      const leg = await manualLeg(po.id);
      const [a, b] = await users();
      await expect(completeManualLeg(pool, leg, { userId: a }, { reference: 'SEPA-1', note: '' })).rejects.toMatchObject({ code: 'approval_required' });
      await approveManualLeg(pool, leg, { userId: a });
      await expect(approveManualLeg(pool, leg, { userId: b })).rejects.toMatchObject({ code: 'already_approved' });
      await expect(completeManualLeg(pool, leg, { userId: a }, { reference: 'SEPA-1', note: '' })).rejects.toMatchObject({ code: 'same_person' });
      const tx = await completeManualLeg(pool, leg, { userId: b }, { reference: 'SEPA-1', note: 'IBAN игрока' });
      expect(tx.status).toBe('success');
      const row = (await pool.query(`SELECT approved_by, completed_by, reference FROM payout_legs WHERE id = $1`, [leg])).rows[0];
      expect(row).toEqual({ approved_by: a, completed_by: b, reference: 'SEPA-1' });
      const log = (await pool.query(`SELECT action, admin_user_id FROM audit_log ORDER BY id`)).rows;
      expect(log).toEqual([{ action: 'payout.manual_approve', admin_user_id: a }, { action: 'payout.manual_complete', admin_user_id: b }]);
      // Даже напрямую в базе один человек не может быть и одобрившим, и исполнившим.
      await expect(pool.query(`UPDATE payout_legs SET completed_by = approved_by WHERE id = $1`, [leg])).rejects.toThrow(/maker_checker/);
    });

    it('ниже порога одобрение не нужно', async () => {
      await pool.query(`UPDATE operators SET manual_approval_above = 100000`);
      await paidDeposit(1000);
      const po = (await payout(3000, 'W-small')).json();
      const leg = await manualLeg(po.id);
      const [a] = await users();
      await expect(approveManualLeg(pool, leg, { userId: a })).rejects.toMatchObject({ code: 'approval_not_needed' });
      expect((await completeManualLeg(pool, leg, { userId: a }, { reference: 'SEPA-2', note: '' })).status).toBe('success');
    });
  });

  // ---------- 6. зачисление только по подтверждённым сумме и валюте ----------

  describe('зачисление только по подтверждённой оплате', () => {
    let override: { amount?: bigint | null; currency?: string | null } = {};
    beforeEach(() => {
      override = {};
      const real = new MockAdapter(mock);
      providers.register({
        name: 'mock', manifest: real.manifest,
        createPayment: (c, r) => real.createPayment(c, r),
        getPayment: async (c, ref) => ({ ...(await real.getPayment(c, ref)), ...override }),
        verifyWebhook: (c, h, b) => real.verifyWebhook(c, h, b),
      });
    });
    const issues = async () => (await pool.query(`SELECT kind, details FROM reconciliation_issues`)).rows;
    const status = async (id: string) => (await pool.query(`SELECT status FROM transactions WHERE id = $1`, [id])).rows[0].status;
    const ledger = async () => (await pool.query(`SELECT count(*)::int c FROM ledger_entries`)).rows[0].c;

    for (const [name, o, kind] of [
      ['провайдер не сообщил сумму', { amount: null }, 'unverified_payment'],
      ['провайдер не сообщил валюту', { currency: null }, 'unverified_payment'],
      ['оплачено в другой валюте', { currency: 'USD' }, 'amount_mismatch'],
      ['оплачена другая сумма', { amount: 999n }, 'amount_mismatch'],
    ] as const) {
      it(`${name} — не зачисляется, уходит в «Проблемы»`, async () => {
        await account();
        const d = (await deposit(1000)).json();
        override = o;
        await mock.complete(d.paymentUrl.split('/').pop(), 'success');
        expect(await status(d.id)).toBe('pending');
        expect(await ledger()).toBe(0);
        expect((await issues()).map((i) => i.kind)).toEqual([kind]);
      });
    }

    it('всё подтверждено — зачисляется', async () => {
      await account();
      const d = (await deposit(1000)).json();
      await mock.complete(d.paymentUrl.split('/').pop(), 'success');
      expect(await status(d.id)).toBe('success');
      expect(await issues()).toEqual([]);
    });
  });
});
