// Карточки провайдеров: одинаковый сценарий подключения для любого провайдера, адрес вебхука сразу,
// журнал входящих вебхуков, провайдер с подписью (TestPay), перенос старого адреса Viva.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { encrypt } from '../src/crypto.js';
import { hashPassword, totpAt, totpStep } from '../src/admin/security.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { VivaAdapter } from '../src/providers/viva.js';
import { TestPayAdapter, TestPaySimulator, signTestPay, TESTPAY_SIGNATURE_HEADER } from '../src/providers/testpay.js';
import { buildSecret } from '../src/providers/credentials.js';
import { MapSecretStore } from '../src/secrets.js';

const url = process.env.TEST_DATABASE_URL;

describe('buildSecret: ключи и секрет вебхука сохраняются разными формами', () => {
  const adapter = new TestPayAdapter(new TestPaySimulator('https://x.test'));
  it('поле, которого нет в форме, не теряется', () => {
    const s1 = buildSecret(adapter, null, { apiKey: 'tp_test_1' });
    const s2 = buildSecret(adapter, s1, { webhookSecret: 'whsec_1' });
    expect(JSON.parse(s2)).toEqual({ apiKey: 'tp_test_1', webhookSecret: 'whsec_1' });
    const s3 = buildSecret(adapter, s2, { apiKey: '', webhookSecret: '' }); // пустые секретные — без изменений
    expect(JSON.parse(s3)).toEqual({ apiKey: 'tp_test_1', webhookSecret: 'whsec_1' });
    expect(() => buildSecret(adapter, null, { webhookSecret: 'whsec_1' })).toThrow(/API-ключ/);
  });
});

describe.skipIf(!url)('Подключение любого провайдера', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let cookie: string;
  let op: string;
  let sim: TestPaySimulator;
  let mock: MockProvider;
  const ENC = Buffer.alloc(32, 9);
  const BASE = 'https://hooks.example';

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE audit_log, admin_sessions, admin_users, payout_legs, reconciliation_issues, webhook_deliveries,
      provider_webhook_log, provider_webhook_events, ledger_entries, transaction_attempts, transactions, account_usage, players,
      merchant_accounts, sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses) VALUES ('Lucky Ltd', '{MT}') RETURNING id`)).rows[0].id;
    mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    sim = new TestPaySimulator('https://pay.test');
    await app?.close();
    app = buildApp({ pool, mock, testpay: sim,
      providers: new ProviderRegistry().register(new MockAdapter(mock)).register(new VivaAdapter({ fetch: async () => ({ ok: false, status: 500, text: async () => '' }) }))
        .register(new TestPayAdapter(sim)),
      secrets: new MapSecretStore({}), rateLimitPerMinute: 100000,
      admin: { encryptionKey: ENC, secureCookies: false, loginRateLimitPerMinute: 100000, webhookBaseUrl: BASE } });
    // Симулятор доставляет вебхуки в этот же сервер — как в src/index.ts.
    sim.deliver = async (u, headers, body) => {
      const x = new URL(u);
      return (await app.inject({ method: 'POST', url: x.pathname + x.search, headers, payload: body })).statusCode;
    };
    await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ('a@x.io', $1, 'admin', false)`,
      [await hashPassword('pass word 12345')]);
    const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: 'pass word 12345' } });
    const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: totpAt(r1.json().totpSecret, totpStep()) },
      cookies: { ftech_admin: (r1.cookies as { name: string; value: string }[])[0]!.value } });
    cookie = (r2.cookies as { name: string; value: string }[])[0]!.value;
  });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: object) =>
    app.inject({ method, url: path, payload: method === 'GET' ? undefined : (payload ?? {}), cookies: { ftech_admin: cookie } });
  const create = async (adapter: string) => (await call('POST', '/admin/v1/connections/accounts', {
    operatorId: op, adapter, name: `${adapter} main`, currencies: ['EUR'], countries: ['MT'],
    minAmount: 100, maxAmount: 200000, dailyCap: 1000000 })).json();
  const conn = async (id: string) => (await call('GET', `/admin/v1/accounts/${id}/connection`)).json();

  it('карточки провайдеров: у каждого схема вебхука, шаги и возможности', async () => {
    const list = (await call('GET', '/admin/v1/connectors')).json();
    const by = Object.fromEntries(list.map((c: { name: string }) => [c.name, c]));
    expect(by.viva.webhook.scheme).toBe('token');
    expect(by.testpay.webhook.scheme).toBe('signature');
    expect(by.testpay.fields.find((f: { key: string }) => f.key === 'webhookSecret').stage).toBe('webhook');
    expect(by.mock.webhook.scheme).toBe('internal');
    for (const c of list) expect(c.capabilities).toHaveProperty('refunds');
  });

  it('адрес вебхука есть сразу после создания аккаунта, до ввода ключей; аккаунт создаётся выключенным', async () => {
    for (const adapter of ['viva', 'testpay']) {
      const a = await create(adapter);
      expect(a).toMatchObject({ needsCredentials: true, enabled: false });
      const c = await conn(a.id);
      expect(c.webhook.url).toMatch(new RegExp(`^${BASE}/v1/provider-webhooks/${a.id}\\?token=[0-9a-f]{48}$`));
      expect(c.webhook.state).toBe('waiting');
      expect(c.steps).toEqual({ keys: false, check: false, webhook: false, live: false });
    }
    const m = await create('mock');
    expect(m.enabled).toBe(true);
    expect((await conn(m.id)).webhook).toMatchObject({ scheme: 'internal', url: null, state: 'internal' });
  });

  it('TestPay целиком: ключ → проверка → адрес в кабинете → секрет → тестовое событие → платёж', async () => {
    const a = await create('testpay');
    const apiKey = sim.createKey();
    await call('PUT', `/admin/v1/accounts/${a.id}/credentials`, { values: { apiKey } });
    let chk = (await call('POST', `/admin/v1/accounts/${a.id}/check`)).json();
    expect(chk.results).toEqual([
      expect.objectContaining({ name: 'API-ключ', ok: true }),
      expect.objectContaining({ name: 'Секрет подписи', ok: false, message: expect.stringMatching(/Не введён/) })]);
    expect((await conn(a.id)).steps).toMatchObject({ keys: true, check: false });

    // В кабинете провайдера: вставили наш адрес, получили секрет.
    const c0 = await conn(a.id);
    const ep = sim.setEndpoint(apiKey, c0.webhook.url);
    // Тестовое событие до ввода секрета — отклоняется с понятной причиной.
    expect(await sim.sendEvent(apiKey, 'test', {})).toBe(401);
    let c = await conn(a.id);
    expect(c.webhook.state).toBe('failing');
    expect(c.webhook.lastError.reason).toMatch(/Секрет подписи не введён/);

    await call('PUT', `/admin/v1/accounts/${a.id}/credentials`, { values: { webhookSecret: ep.secret } });
    chk = (await call('POST', `/admin/v1/accounts/${a.id}/check`)).json();
    expect(chk.ok).toBe(true);
    expect(await sim.sendEvent(apiKey, 'test', {})).toBe(200);
    c = await conn(a.id);
    expect(c.webhook).toMatchObject({ state: 'ok', secretSet: true });
    expect(c.webhook.log[0]).toMatchObject({ outcome: 'test' });
    expect(c.steps).toMatchObject({ keys: true, check: true, webhook: true, live: false });

    // Включаем и проводим платёж: статус приходит подписанным вебхуком.
    expect((await call('PATCH', `/admin/v1/accounts/${a.id}`, { enabled: true })).statusCode).toBe(200);
    const k = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 's', $2)`, [op, k.hash]);
    const d = (await app.inject({ method: 'POST', url: '/v1/deposits', headers: { authorization: `Bearer ${k.key}`, 'idempotency-key': 'tp-dep-0001' },
      payload: { amount: 2500, currency: 'EUR', player: { id: 'p1', country: 'MT', kyc: 'verified' } } })).json();
    expect(d.paymentUrl).toMatch(/^https:\/\/pay\.test\/testpay\/pay\/tp_pay_/);
    await sim.complete(d.paymentUrl.split('/').pop(), 'success');
    const tx = (await app.inject({ method: 'GET', url: `/v1/deposits/${d.id}`, headers: { authorization: `Bearer ${k.key}` } })).json();
    expect(tx.status).toBe('success');
    c = await conn(a.id);
    expect(c.steps.live).toBe(true);
    expect(c.ready).toBe(true);
    expect(c.webhook.log[0]).toMatchObject({ outcome: 'accepted', reason: 'Статус платежа обновлён' });
  });

  it('журнал объясняет, что не так: чужая подпись, неверный токен, нет токена', async () => {
    const a = await create('testpay');
    const apiKey = sim.createKey();
    await call('PUT', `/admin/v1/accounts/${a.id}/credentials`, { values: { apiKey, webhookSecret: 'whsec_ours' } });
    const good = (await conn(a.id)).webhook.url as string;
    const path = good.replace(BASE, '');
    const body = JSON.stringify({ id: 'evt_1', type: 'test', data: {} });
    const send = (u: string, secret: string) => app.inject({ method: 'POST', url: u, payload: body,
      headers: { 'content-type': 'application/json', [TESTPAY_SIGNATURE_HEADER]: signTestPay(secret, body) } });
    expect((await send(path, 'whsec_other')).statusCode).toBe(401);
    expect((await send(path.replace(/token=\w+/, 'token=' + 'a'.repeat(48)), 'whsec_ours')).statusCode).toBe(401);
    expect((await send(path.replace(/\?token=\w+/, ''), 'whsec_ours')).statusCode).toBe(401);
    const reasons = (await conn(a.id)).webhook.log.map((r: { reason: string }) => r.reason);
    expect(reasons).toEqual([
      expect.stringMatching(/нет токена/), expect.stringMatching(/старый или чужой адрес/), expect.stringMatching(/Подпись не сходится/)]);
    // Секрет поправили — следующий вебхук проходит, статус снова зелёный.
    expect((await send(path, 'whsec_ours')).statusCode).toBe(200);
    expect((await conn(a.id)).webhook.state).toBe('ok');
  });

  it('новый адрес вебхука: старый перестаёт работать', async () => {
    const a = await create('viva');
    const before = (await conn(a.id)).webhook.url;
    await call('POST', `/admin/v1/accounts/${a.id}/webhook-token`);
    const after = (await conn(a.id)).webhook.url;
    expect(after).not.toBe(before);
    const r = await app.inject({ method: 'POST', url: before.replace(BASE, ''), payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(401);
    const audit = (await pool.query(`SELECT action FROM audit_log WHERE action = 'account.webhook_token'`)).rows;
    expect(audit).toHaveLength(1);
  });

  it('старый аккаунт Viva: адрес, уже вставленный в кабинет Viva, продолжает работать после пересохранения ключей', async () => {
    const legacy = 'f'.repeat(48);
    const prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('viva', 'Viva', 'viva') RETURNING id`)).rows[0].id;
    const secret = JSON.stringify({ env: 'demo', clientId: 'c', clientSecret: 's', merchantId: 'm', apiKey: 'k', currency: 'EUR', webhookToken: legacy });
    const id = (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, credentials_enc)
       VALUES ($1, $2, 'old viva', '{EUR}', '{MT}', 100, 1000, 10000, $3) RETURNING id`, [op, prov, encrypt(ENC, secret)])).rows[0].id;
    await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: { clientSecret: 'new' } });
    expect((await conn(id)).webhook.url).toBe(`${BASE}/v1/provider-webhooks/${id}?token=${legacy}`);
  });
});
