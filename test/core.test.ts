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
    await pool.query(`TRUNCATE player_restriction_events, payout_legs, reconciliation_issues, webhook_deliveries, provider_webhook_log,
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
});
