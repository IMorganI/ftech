// «Подключения»: ключи провайдеров в борде (зашифрованы), проверка, адрес вебхука, готовность оператора.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { hashPassword, totpAt, totpStep } from '../src/admin/security.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { VivaAdapter, type HttpFetch } from '../src/providers/viva.js';
import { MapSecretStore } from '../src/secrets.js';

const url = process.env.TEST_DATABASE_URL;

/** Минимальная имитация Viva: какие ключи «правильные» и какие права у токена. */
function fakeViva(opts: { scope: string }) {
  const calls: string[] = [];
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const no = (status: number) => ({ ok: false, status, text: async () => '' });
  const fetch: HttpFetch = async (u, init) => {
    calls.push(`${init.method} ${u}`);
    const auth = init.headers.authorization ?? '';
    if (u.endsWith('/connect/token')) {
      return auth === 'Basic ' + Buffer.from('cid:csecret').toString('base64') ? ok({ access_token: 't', expires_in: 3600, scope: opts.scope }) : no(400);
    }
    if (u.endsWith('/api/messages/config/token')) return auth === 'Basic ' + Buffer.from('mid:akey').toString('base64') ? ok({ Key: 'K' }) : no(401);
    if (u.endsWith('/checkout/v2/orders')) return ok({ orderCode: 1234567890123456 });
    return no(404);
  };
  return { fetch, calls };
}

describe.skipIf(!url)('Подключения', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let cookie: string;
  let op: string;
  let viva: ReturnType<typeof fakeViva>;
  const ENC = Buffer.alloc(32, 5);

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  async function setup(scope = 'urn:viva:payments:core:api:redirectcheckout') {
    await pool.query(`TRUNCATE audit_log, admin_sessions, admin_users, payout_legs, reconciliation_issues, webhook_deliveries,
      provider_webhook_events, ledger_entries, transaction_attempts, transactions, account_usage, players, merchant_accounts,
      sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses) VALUES ('Lucky Ltd', '{MT}') RETURNING id`)).rows[0].id;
    viva = fakeViva({ scope });
    const mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    await app?.close();
    app = buildApp({ pool, mock, providers: new ProviderRegistry().register(new MockAdapter(mock)).register(new VivaAdapter({ fetch: viva.fetch })),
      secrets: new MapSecretStore({}), rateLimitPerMinute: 100000,
      admin: { encryptionKey: ENC, secureCookies: false, loginRateLimitPerMinute: 100000, webhookBaseUrl: 'https://hooks.example' } });
    await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ('a@x.io', $1, 'admin', false)`,
      [await hashPassword('pass word 12345')]);
    const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: 'pass word 12345' } });
    const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: totpAt(r1.json().totpSecret, totpStep()) },
      cookies: { ftech_admin: (r1.cookies as { name: string; value: string }[])[0]!.value } });
    cookie = (r2.cookies as { name: string; value: string }[])[0]!.value;
  }
  beforeEach(() => setup());

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    app.inject({ method, url: path, payload: method === 'GET' ? undefined : (payload ?? {}), cookies: { ftech_admin: cookie } });

  const newViva = async () => (await call('POST', '/admin/v1/connections/accounts', {
    operatorId: op, adapter: 'viva', name: 'Viva main', currencies: ['EUR'], countries: ['MT'],
    minAmount: 100, maxAmount: 200000, dailyCap: 1000000, feeBps: 190 })).json();

  const KEYS = { env: 'demo', clientId: 'cid', clientSecret: 'csecret', merchantId: 'mid', apiKey: 'akey', currency: 'EUR' };

  it('список интеграций с полями ключей', async () => {
    const list = (await call('GET', '/admin/v1/connectors')).json();
    const v = list.find((c: { name: string }) => c.name === 'viva');
    expect(v.title).toMatch(/Viva/);
    expect(v.fields.map((f: { key: string }) => f.key)).toEqual(['env', 'clientId', 'clientSecret', 'merchantId', 'apiKey', 'sourceCode', 'currency']);
    expect(v.fields.find((f: { key: string }) => f.key === 'clientSecret').secret).toBe(true);
    expect(list.find((c: { name: string }) => c.name === 'mock').fields).toEqual([]);
  });

  it('аккаунт создаётся с интеграцией, провайдер появляется сам', async () => {
    const a = await newViva();
    expect(a.needsCredentials).toBe(true);
    expect((await pool.query(`SELECT code, adapter FROM providers`)).rows).toEqual([{ code: 'viva', adapter: 'viva' }]);
    await newViva(); // второй аккаунт того же провайдера не дублирует провайдера
    expect((await pool.query(`SELECT count(*)::int c FROM providers`)).rows[0].c).toBe(1);
  });

  it('ключи: обязательные поля, шифрование, маскирование, сохранение секретов при правке', async () => {
    const { id } = await newViva();
    const bad = await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: { env: 'demo', clientId: 'cid' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/Client Secret.*Merchant ID.*API Key/);

    expect((await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: KEYS })).json()).toEqual({ ok: true });
    const enc = (await pool.query(`SELECT credentials_enc FROM merchant_accounts WHERE id = $1`, [id])).rows[0].credentials_enc;
    expect(enc).toMatch(/^v1\./);
    expect(enc).not.toContain('csecret');

    const c1 = (await call('GET', `/admin/v1/accounts/${id}/connection`)).json();
    expect(c1.source).toBe('board');
    expect(c1.values).toMatchObject({ env: { value: 'demo' }, clientId: { value: 'cid' }, clientSecret: { masked: '••••cret' }, apiKey: { masked: '••••akey' } });
    expect(JSON.stringify(c1)).not.toContain('csecret');
    expect(c1.webhook.url).toMatch(new RegExp(`^https://hooks\\.example/v1/provider-webhooks/${id}\\?token=[0-9a-f]{48}$`));
    expect(c1.webhook.events).toContain('Transaction Payment Created');

    // Правка без секретов: секреты и токен вебхука остаются прежними
    await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: { ...KEYS, clientSecret: '', apiKey: '', clientId: 'cid' } });
    const c2 = (await call('GET', `/admin/v1/accounts/${id}/connection`)).json();
    expect(c2.values.clientSecret.masked).toBe('••••cret');
    expect(c2.webhook.url).toBe(c1.webhook.url);

    const log = JSON.stringify((await pool.query(`SELECT after FROM audit_log WHERE action = 'account.credentials'`)).rows);
    expect(log).toContain('clientId');
    expect(log).not.toContain('csecret');
    expect(log).not.toContain('akey');
  });

  it('проверка подключения: всё зелёное с правильными ключами', async () => {
    const { id } = await newViva();
    await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: KEYS });
    const r = (await call('POST', `/admin/v1/accounts/${id}/check`)).json();
    expect(r.ok).toBe(true);
    expect(r.results.map((x: { name: string }) => x.name)).toEqual(['Client ID и Client Secret', 'Права на онлайн-оплату', 'Merchant ID и API Key']);
    expect(viva.calls.some((x) => x.includes('/checkout/v2/orders'))).toBe(false); // проверка не создаёт платежей
    expect((await call('GET', `/admin/v1/accounts/${id}/connection`)).json().lastCheck.ok).toBe(true);
  });

  it('проверка ловит ключи от POS и неверный API Key — с понятными причинами', async () => {
    await setup('urn:viva:payments:core:api:posmanagement urn:viva:payments:ecr:api');
    const { id } = await newViva();
    await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: { ...KEYS, apiKey: 'wrong' } });
    const r = (await call('POST', `/admin/v1/accounts/${id}/check`)).json();
    expect(r.ok).toBe(false);
    const msg = Object.fromEntries(r.results.map((x: { name: string; ok: boolean; message: string }) => [x.name, x]));
    expect(msg['Права на онлайн-оплату']).toMatchObject({ ok: false, message: expect.stringMatching(/не от Smart Checkout.*posmanagement/) });
    expect(msg['Merchant ID и API Key'].ok).toBe(false);
  });

  it('без ключей проверка подсказывает, где их ввести', async () => {
    const { id } = await newViva();
    const r = (await call('POST', `/admin/v1/accounts/${id}/check`)).json();
    expect(r.results[0].message).toMatch(/Подключения/);
  });

  it('платёж через аккаунт с ключами из борды доходит до Viva', async () => {
    const { id } = await newViva();
    await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: KEYS });
    const k = generateApiKey();
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 's', $2)`, [op, k.hash]);
    const d = (await app.inject({ method: 'POST', url: '/v1/deposits', headers: { authorization: `Bearer ${k.key}`, 'idempotency-key': 'conn-dep-1' },
      payload: { amount: 1000, currency: 'EUR', player: { id: 'p', country: 'MT', kyc: 'verified' } } })).json();
    expect(d).toMatchObject({ status: 'pending', paymentUrl: 'https://demo.vivapayments.com/web/checkout?ref=1234567890123456' });
  });

  it('тестовый провайдер не требует ключей и сразу готов', async () => {
    const a = (await call('POST', '/admin/v1/connections/accounts', { operatorId: op, adapter: 'mock', name: 'Test', currencies: ['EUR'],
      countries: ['MT'], minAmount: 100, maxAmount: 100000, dailyCap: 1000000 })).json();
    expect(a.needsCredentials).toBe(false);
    expect((await call('POST', `/admin/v1/accounts/${a.id}/check`)).json().ok).toBe(true);
  });

  it('готовность оператора меняется по шагам', async () => {
    const steps = async () => Object.fromEntries((await call('GET', `/admin/v1/operators/${op}/readiness`)).json().steps
      .map((s: { key: string; done: boolean }) => [s.key, s.done]));
    expect(await steps()).toMatchObject({ account: false, keys: false, check: false, site: false, deposit: false });
    const { id } = await newViva();
    expect(await steps()).toMatchObject({ account: true, keys: false });
    await call('PUT', `/admin/v1/accounts/${id}/credentials`, { values: KEYS });
    await call('POST', `/admin/v1/accounts/${id}/check`);
    expect(await steps()).toMatchObject({ keys: true, check: true, site: false });
    const r = (await call('GET', `/admin/v1/operators/${op}/readiness`)).json();
    expect(r.ready).toBe(false);
  });

  it('несогласованные лимиты при создании аккаунта отклоняются', async () => {
    const r = await call('POST', '/admin/v1/connections/accounts', { operatorId: op, adapter: 'viva', name: 'x', currencies: ['EUR'],
      countries: ['MT'], minAmount: 5000, maxAmount: 100, dailyCap: 1000 });
    expect(r.statusCode).toBe(400);
  });
});
