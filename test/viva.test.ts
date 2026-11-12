// Адаптер Viva Wallet на имитации их API: настоящие запросы в Viva в тестах не уходят.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VivaAdapter, parseVivaCredentials, parseVivaAmount, type HttpFetch } from '../src/providers/viva.js';
import { InvalidWebhookError, ProviderRegistry } from '../src/providers/types.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { MapSecretStore } from '../src/secrets.js';
import { reconcilePending } from '../src/payments/flow.js';

const TOKEN = 'wh_' + 'x'.repeat(30);
const SECRET = JSON.stringify({ env: 'demo', clientId: 'cid', clientSecret: 'csec', merchantId: 'mid', apiKey: 'akey', sourceCode: '1234', webhookToken: TOKEN });
const creds = { accountId: 'acc', secret: SECRET };

/** Имитация Viva: OAuth, создание заказа, статус заказа, ключ вебхука. */
function fakeViva() {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const orders = new Map<string, number>(); // orderCode → StateId
  const amounts = new Map<string, number>(); // orderCode → сумма в центах, как её передали
  let next = 2271655739472609n; // 16 цифр, как у Viva
  let tokenIssued = 0;
  const state = { failCreateWith: 0, failStatusWith: 0 };
  const respond = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url === 'https://demo-accounts.vivapayments.com/connect/token') {
      if (init.headers.authorization !== 'Basic ' + Buffer.from('cid:csec').toString('base64')) return respond(401, {});
      tokenIssued++;
      return respond(200, { access_token: `tok${tokenIssued}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (url === 'https://demo-api.vivapayments.com/checkout/v2/orders') {
      if (state.failCreateWith) return respond(state.failCreateWith, state.failCreateWith === 403 ? '' : { message: 'error' }); // настоящая Viva на 403 отвечает пустым телом
      if (!init.headers.authorization?.startsWith('Bearer tok')) return respond(401, {});
      const code = (next++).toString();
      orders.set(code, 0);
      amounts.set(code, JSON.parse(init.body!).amount);
      return respond(200, `{"orderCode":${code}}`); // число без кавычек, как в ответе Viva
    }
    const m = /^https:\/\/demo\.vivapayments\.com\/api\/orders\/(\d+)$/.exec(url);
    if (m) {
      if (state.failStatusWith) return respond(state.failStatusWith, {});
      if (init.headers.authorization !== 'Basic ' + Buffer.from('mid:akey').toString('base64')) return respond(401, {});
      if (!orders.has(m[1]!)) return respond(404, {});
      const cents = amounts.get(m[1]!)!;
      // Viva отдаёт сумму в евро с двумя знаками, как в реальном ответе: "RequestAmount":5.00
      return respond(200, `{"OrderCode":${m[1]},"RequestAmount":${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')},"StateId":${orders.get(m[1]!)}}`);
    }
    if (url === 'https://demo.vivapayments.com/api/messages/config/token') return respond(200, { Key: 'VIVA-VERIFY-KEY' });
    return respond(404, {});
  };
  return { fetch, calls, orders, amounts, state, tokenCount: () => tokenIssued };
}

const req = (amount = 2500n) => ({ reference: 'attempt-1', amount, currency: 'EUR', country: 'MT', returnUrl: null });

describe('Viva: адаптер', () => {
  it('создаёт заказ: OAuth, сумма в центах, наш ID попытки, ссылка на Smart Checkout', async () => {
    const v = fakeViva();
    const r = await new VivaAdapter({ fetch: v.fetch }).createPayment(creds, req());
    expect(r).toEqual({ kind: 'redirect', providerRef: '2271655739472609', redirectUrl: 'https://demo.vivapayments.com/web/checkout?ref=2271655739472609' });
    const order = v.calls.find((c) => c.url.endsWith('/checkout/v2/orders'))!;
    expect(JSON.parse(order.body!)).toEqual({ amount: 2500, customerTrns: 'Пополнение счёта', merchantTrns: 'attempt-1', sourceCode: '1234' });
    expect(order.headers.authorization).toBe('Bearer tok1');
  });

  it('токен OAuth переиспользуется, а не запрашивается на каждый платёж', async () => {
    const v = fakeViva();
    const a = new VivaAdapter({ fetch: v.fetch });
    await a.createPayment(creds, req()); await a.createPayment(creds, req()); await a.createPayment(creds, req());
    expect(v.tokenCount()).toBe(1);
  });

  it('16-значный orderCode не теряет точность', async () => {
    const v = fakeViva();
    const r = await new VivaAdapter({ fetch: v.fetch }).createPayment(creds, req());
    expect(r.kind === 'redirect' && r.providerRef).toBe('2271655739472609');
  });

  it('другая валюта — отказ без запроса в Viva', async () => {
    const v = fakeViva();
    const r = await new VivaAdapter({ fetch: v.fetch }).createPayment(creds, { ...req(), currency: 'BRL' });
    expect(r).toMatchObject({ kind: 'declined' });
    expect(v.calls).toHaveLength(0);
  });

  it('4xx от Viva — отказ (пойдёт каскад), 5xx — ошибка (разберёт сверка)', async () => {
    const v = fakeViva();
    const a = new VivaAdapter({ fetch: v.fetch });
    v.state.failCreateWith = 400;
    expect(await a.createPayment(creds, req())).toEqual({ kind: 'declined', reason: 'viva_http_400: error' });
    v.state.failCreateWith = 403;
    expect(await a.createPayment(creds, req())).toMatchObject({ reason: expect.stringMatching(/^viva_http_403: .*Smart Checkout/) });
    v.state.failCreateWith = 503;
    await expect(a.createPayment(creds, req())).rejects.toThrow(/503/);
  });

  it('статус заказа: 0 — ждёт, 1/2 — отказ, 3 — оплачен', async () => {
    const v = fakeViva();
    const a = new VivaAdapter({ fetch: v.fetch });
    const r = await a.createPayment(creds, req());
    const ref = r.kind === 'redirect' ? r.providerRef : '';
    for (const [state, want] of [[0, 'pending'], [1, 'declined'], [2, 'declined'], [3, 'success']] as const) {
      v.orders.set(ref, state);
      expect(await a.getStatus(creds, ref)).toBe(want);
    }
  });

  it('сумма Viva разбирается без потери точности', () => {
    expect(parseVivaAmount('{"RequestAmount":5.00,"StateId":3}')).toBe(500n);
    expect(parseVivaAmount('{"RequestAmount":25.5}')).toBe(2550n);
    expect(parseVivaAmount('{"RequestAmount":1234567.89}')).toBe(123456789n);
    expect(parseVivaAmount('{"RequestAmount":7}')).toBe(700n);
    expect(parseVivaAmount('{"StateId":3}')).toBeNull();
  });

  it('вебхук без токена или с чужим токеном отклоняется', () => {
    const a = new VivaAdapter({ fetch: fakeViva().fetch });
    const body = '{"EventData":{"OrderCode":2271655739472609,"StatusId":"F"},"MessageId":"m-1","EventTypeId":1796}';
    expect(() => a.verifyWebhook(creds, {}, body, {})).toThrow(InvalidWebhookError);
    expect(() => a.verifyWebhook(creds, {}, body, { token: 'wh_' + 'y'.repeat(30) })).toThrow(InvalidWebhookError);
    expect(a.verifyWebhook(creds, {}, body, { token: TOKEN })).toEqual({ eventId: 'm-1', providerRef: '2271655739472609' });
  });

  it('проверка адреса вебхука отдаёт ключ Viva', async () => {
    const a = new VivaAdapter({ fetch: fakeViva().fetch });
    expect(await a.webhookChallenge(creds, { token: TOKEN })).toEqual({ Key: 'VIVA-VERIFY-KEY' });
    await expect(a.webhookChallenge(creds, {})).rejects.toThrow(InvalidWebhookError);
  });

  it('понятные ошибки в секрете', () => {
    expect(() => parseVivaCredentials('not json')).toThrow(/JSON/);
    expect(() => parseVivaCredentials('{"env":"demo"}')).toThrow(/clientId/);
    expect(() => parseVivaCredentials(SECRET.replace('"demo"', '"prod"'))).toThrow(/env/);
    expect(() => parseVivaCredentials(SECRET.replace(TOKEN, 'short'))).toThrow(/24/);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Viva: сквозной платёж через роутер', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let v: ReturnType<typeof fakeViva>;
  let key: string;
  let acc: string;
  let providers: ProviderRegistry;
  const secrets = new MapSecretStore({ VIVA: SECRET });

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE reconciliation_issues, webhook_deliveries, provider_webhook_events, ledger_entries, transaction_attempts, transactions,
      account_usage, players, merchant_accounts, sites, providers, operators CASCADE`);
    const op = (await pool.query(`INSERT INTO operators (name, licenses, platform_fee_bps) VALUES ('Op', '{MT}', 150) RETURNING id`)).rows[0].id;
    const k = generateApiKey(); key = k.key;
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'S', $2)`, [op, k.hash]);
    const prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('viva', 'Viva Wallet', 'viva') RETURNING id`)).rows[0].id;
    acc = (await pool.query(`INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, credentials_ref)
      VALUES ($1, $2, 'Viva demo', '{EUR}', '{MT}', 100, 1000000, 10000000, 190, 'VIVA') RETURNING id`, [op, prov])).rows[0].id;
    v = fakeViva();
    providers = new ProviderRegistry().register(new VivaAdapter({ fetch: v.fetch }));
    await app?.close();
    app = buildApp({ pool, providers, secrets, rateLimitPerMinute: 100000 });
  });

  const deposit = async () => (await app.inject({ method: 'POST', url: '/v1/deposits',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': `viva-${Math.random()}` },
    payload: { amount: 2500, currency: 'EUR', player: { id: 'p1', country: 'MT', kyc: 'verified' } } })).json();
  const hook = (orderCode: string, token = TOKEN, messageId = 'msg-' + Math.random()) => app.inject({
    method: 'POST', url: `/v1/provider-webhooks/${acc}?token=${token}`, headers: { 'content-type': 'application/json' },
    payload: `{"Url":"x","EventData":{"OrderCode":${orderCode},"TransactionId":"t","StatusId":"F","Amount":25.00},"EventTypeId":1796,"MessageId":"${messageId}"}`,
  });

  it('депозит → ссылка Viva → вебхук → статус перепроверен → успех с комиссиями', async () => {
    const d = await deposit();
    expect(d).toMatchObject({ status: 'pending', paymentUrl: 'https://demo.vivapayments.com/web/checkout?ref=2271655739472609' });
    // вебхук пришёл, но в Viva заказ ещё не оплачен — ничего не меняем
    expect((await hook('2271655739472609')).json().result).toBe('still_pending');
    // игрок оплатил
    v.orders.set('2271655739472609', 3);
    expect((await hook('2271655739472609')).json().result).toBe('processed');
    const tx = (await pool.query(`SELECT status, platform_fee, provider_fee FROM transactions WHERE id = $1`, [d.id])).rows[0];
    expect(tx).toEqual({ status: 'success', platform_fee: 37n, provider_fee: 47n }); // 1.5% и 1.9% от 25.00
  });

  it('поддельный вебхук без токена — 401, без запросов к Viva', async () => {
    await deposit();
    v.orders.set('2271655739472609', 3);
    const before = v.calls.length;
    expect((await hook('2271655739472609', 'wh_' + 'z'.repeat(30))).statusCode).toBe(401);
    expect(v.calls.length).toBe(before);
  });

  it('оплачена не та сумма — не зачисляем, проблема для ручного разбора', async () => {
    const d = await deposit();
    v.orders.set('2271655739472609', 3);
    v.amounts.set('2271655739472609', 250); // Viva говорит: оплачено 2.50 вместо 25.00
    expect((await hook('2271655739472609')).json().result).toBe('issue_recorded');
    expect((await pool.query(`SELECT status FROM transactions WHERE id = $1`, [d.id])).rows[0].status).toBe('pending');
    const i = (await pool.query(`SELECT kind, details FROM reconciliation_issues`)).rows[0];
    expect(i.kind).toBe('amount_mismatch');
    expect(i.details).toMatch(/25\.00 EUR.*2\.50/);
  });

  it('Viva проверяет адрес вебхука GET-запросом и получает ключ', async () => {
    const ok = await app.inject({ method: 'GET', url: `/v1/provider-webhooks/${acc}?token=${TOKEN}` });
    expect(ok.json()).toEqual({ Key: 'VIVA-VERIFY-KEY' });
    expect((await app.inject({ method: 'GET', url: `/v1/provider-webhooks/${acc}` })).statusCode).toBe(401);
  });

  it('без вебхука платёж подтверждает сверка; истёкший заказ закрывается отказом', async () => {
    const d1 = await deposit();
    const d2 = await deposit();
    v.orders.set('2271655739472609', 3); // первый оплачен
    v.orders.set('2271655739472610', 1); // второй истёк
    await pool.query(`UPDATE transaction_attempts SET submitted_at = now() - interval '10 minutes'`);
    await reconcilePending({ pool, providers, secrets }, 300);
    const st = async (id: string) => (await pool.query(`SELECT status, decline_code FROM transactions WHERE id = $1`, [id])).rows[0];
    expect(await st(d1.id)).toEqual({ status: 'success', decline_code: null });
    expect(await st(d2.id)).toEqual({ status: 'declined', decline_code: 'all_attempts_failed' });
  });
});
