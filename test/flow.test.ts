// Сквозной поток: сайт создал депозит → игрок оплатил у провайдера → вебхук → сайт уведомлён.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { encrypt, decrypt, hmacHex, randomSecret } from '../src/crypto.js';
import { ProviderRegistry, type ProviderAdapter } from '../src/providers/types.js';
import { MockAdapter, MockProvider, signMockWebhook } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { dispatchOnce, MAX_DELIVERY_ATTEMPTS, type Fetcher } from '../src/webhooks/outbox.js';
import { reconcilePending } from '../src/payments/flow.js';

const url = process.env.TEST_DATABASE_URL;
const ENC_KEY = Buffer.alloc(32, 7);
const ACCOUNT_SECRET = 'acc-secret';

describe('Шифрование', () => {
  it('расшифровывает своё и отвергает подделку', () => {
    const t = encrypt(ENC_KEY, 'whsec_123');
    expect(decrypt(ENC_KEY, t)).toBe('whsec_123');
    const parts = t.split('.');
    parts[3] = Buffer.from('другое').toString('base64url');
    expect(() => decrypt(ENC_KEY, parts.join('.'))).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 1), t)).toThrow();
  });
});

describe.skipIf(!url)('Сквозной платёжный поток', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let mock: MockProvider;
  let providers: ProviderRegistry;
  let randoms: number[];
  let key: string;
  let siteSecret: string;
  let op: string;
  let prov: string;
  let n = 0;
  const secrets = new MapSecretStore({ MOCK: ACCOUNT_SECRET });

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE reconciliation_issues, webhook_deliveries, provider_webhook_events, ledger_entries,
      transaction_attempts, transactions, account_usage, players, merchant_accounts, sites, providers, operators CASCADE`);
    op = (await pool.query(`INSERT INTO operators (name, licenses, max_attempts) VALUES ('Op', '{MT}', 3) RETURNING id`)).rows[0].id;
    const k = generateApiKey();
    key = k.key;
    siteSecret = randomSecret('whsec_');
    await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash, webhook_url, webhook_secret_enc)
      VALUES ($1, 'S', $2, 'https://site.test/hooks', $3)`, [op, k.hash, encrypt(ENC_KEY, siteSecret)]);
    prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;

    // Управляемая «случайность» мока: числа берутся из очереди, по умолчанию 0.99 (не отказывать, не дублировать).
    randoms = [];
    mock = new MockProvider({ publicBaseUrl: 'https://pay.test', instantDeclineRate: 0.5, duplicateWebhookRate: 0.5,
      random: () => randoms.shift() ?? 0.99 });
    providers = new ProviderRegistry().register(new MockAdapter(mock));
    await app?.close();
    app = buildApp({ pool, providers, secrets, mock, rateLimitPerMinute: 100000 });
    mock.sink = async (accountId, headers, body) => {
      await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${accountId}`, headers, payload: body });
    };
  });

  async function account(name: string, fee: number) {
    return (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, credentials_ref)
       VALUES ($1, $2, $3, '{EUR}', '{MT}', 100, 1000000, 1000000, $4, 'MOCK') RETURNING id`, [op, prov, name, fee],
    )).rows[0].id as string;
  }

  async function deposit(amount = 5000, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST', url: '/v1/deposits',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': `flow-${++n}-${Date.now()}` },
      payload: { amount, currency: 'EUR', player: { id: 'p1', country: 'MT', kyc: 'verified' }, ...extra },
    });
    return res.json();
  }

  const refOf = (paymentUrl: string) => paymentUrl.split('/').pop()!;
  const tx = async (id: string) => (await pool.query(`SELECT * FROM transactions WHERE id = $1`, [id])).rows[0];
  const attempts = async (id: string) => (await pool.query(
    `SELECT a.*, m.name FROM transaction_attempts a JOIN merchant_accounts m ON m.id = a.merchant_account_id
     WHERE transaction_id = $1 ORDER BY attempt_no`, [id])).rows;
  const deliveries = async () => (await pool.query(`SELECT * FROM webhook_deliveries ORDER BY id`)).rows;
  const ledgerCount = async () => (await pool.query(`SELECT count(*)::int c FROM ledger_entries`)).rows[0].c;

  function captureFetch(status = 200) {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const f: Fetcher = async (u, init) => { calls.push({ url: u, headers: init.headers, body: init.body }); return { ok: status < 300, status }; };
    return { f, calls };
  }

  // ---------- счастливый путь ----------

  it('депозит → оплата → вебхук → успех → сайт получает подписанное уведомление', async () => {
    await account('A', 100);
    const d = await deposit(5000);
    expect(d.status).toBe('pending');
    expect(d.paymentUrl).toMatch(/^https:\/\/pay\.test\/mock-provider\/pay\/mock_/);

    await mock.complete(refOf(d.paymentUrl), 'success');

    expect((await tx(d.id)).status).toBe('success');
    expect(await ledgerCount()).toBe(2);

    const { f, calls } = captureFetch();
    expect(await dispatchOnce({ pool, encryptionKey: ENC_KEY, fetch: f })).toEqual({ delivered: 1, failed: 0 });
    expect(calls[0]!.url).toBe('https://site.test/hooks');
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({ event: 'deposit.succeeded', data: { id: d.id, status: 'success', amount: '5000' } });
    // Сайт проверяет подпись своим секретом
    const [t, v1] = calls[0]!.headers['ftech-signature']!.split(',').map((x) => x.split('=')[1]);
    expect(v1).toBe(hmacHex(siteSecret, `${t}.${calls[0]!.body}`));
    expect((await deliveries())[0].status).toBe('delivered');
  });

  it('страница оплаты мока: открывается, кнопка «Оплатить» возвращает игрока на сайт', async () => {
    await account('A', 100);
    const d = await deposit(5000, { returnUrl: 'https://casino.test/return' });
    const ref = refOf(d.paymentUrl);
    const page = await app.inject({ method: 'GET', url: `/mock-provider/pay/${ref}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('50.00 EUR');
    const pay = await app.inject({ method: 'POST', url: `/mock-provider/pay/${ref}/success`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' });
    expect(pay.statusCode).toBe(303);
    expect(pay.headers.location).toBe('https://casino.test/return');
    expect((await tx(d.id)).status).toBe('success');
  });

  it('GET отдаёт ссылку на оплату, пока платёж ожидает', async () => {
    await account('A', 100);
    const d = await deposit();
    const res = await app.inject({ method: 'GET', url: `/v1/deposits/${d.id}`, headers: { authorization: `Bearer ${key}` } });
    expect(res.json().paymentUrl).toBe(d.paymentUrl);
  });

  // ---------- безопасность вебхуков ----------

  it('вебхук с чужой подписью отклоняется и ничего не меняет', async () => {
    const acc = await account('A', 100);
    const d = await deposit();
    const body = JSON.stringify({ eventId: 'e1', paymentRef: refOf(d.paymentUrl), status: 'success' });
    const res = await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${acc}`,
      headers: signMockWebhook('wrong-secret', body), payload: body });
    expect(res.statusCode).toBe(401);
    expect((await tx(d.id)).status).toBe('pending');
  });

  it('старый (перехваченный) вебхук отклоняется', async () => {
    const acc = await account('A', 100);
    const d = await deposit();
    const body = JSON.stringify({ eventId: 'e1', paymentRef: refOf(d.paymentUrl), status: 'success' });
    const res = await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${acc}`,
      headers: signMockWebhook(ACCOUNT_SECRET, body, Math.floor(Date.now() / 1000) - 3600), payload: body });
    expect(res.statusCode).toBe(401);
  });

  it('статус из тела вебхука не принимается на веру: решает ответ провайдера', async () => {
    const acc = await account('A', 100);
    const d = await deposit();
    // Подпись верная, в теле «success», но у провайдера платёж ещё не оплачен
    const body = JSON.stringify({ eventId: 'e-lie', paymentRef: refOf(d.paymentUrl), status: 'success' });
    const res = await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${acc}`,
      headers: signMockWebhook(ACCOUNT_SECRET, body), payload: body });
    expect(res.json().result).toBe('still_pending');
    expect((await tx(d.id)).status).toBe('pending');
    expect(await ledgerCount()).toBe(0);
  });

  it('дубли вебхуков не задваивают деньги', async () => {
    await account('A', 100);
    const d = await deposit();
    const ref = refOf(d.paymentUrl);
    randoms.push(0.1); // мок пришлёт вебхук дважды (разные eventId)
    await mock.complete(ref, 'success');
    const p = mock.payments.get(ref)!;
    await mock.sendWebhook(p, 'same-event'); // и ещё два с одинаковым eventId
    await mock.sendWebhook(p, 'same-event');
    expect(await ledgerCount()).toBe(2);
    const events = (await pool.query(`SELECT result FROM provider_webhook_events ORDER BY id`)).rows.map((r) => r.result);
    expect(events).toHaveLength(3); // повтор same-event даже не записывается
    expect((await deliveries()).filter((x) => x.event === 'deposit.succeeded')).toHaveLength(1);
  });

  // ---------- каскад ----------

  it('мгновенный отказ провайдера → платёж уходит на следующий аккаунт', async () => {
    await account('Дешёвый', 100);
    await account('Запасной', 200);
    randoms.push(0.1); // первый create — отказ
    const d = await deposit();
    expect(d.status).toBe('pending');
    expect(d.paymentUrl).toBeTruthy();
    const a = await attempts(d.id);
    expect(a.map((x) => [x.name, x.status])).toEqual([['Дешёвый', 'declined'], ['Запасной', 'pending']]);
    expect(a[0].error).toBe('do_not_honor');
  });

  it('отказ на странице оплаты → каскад, сайт получает новую ссылку на оплату', async () => {
    await account('A', 100);
    await account('B', 200);
    const d = await deposit();
    await mock.complete(refOf(d.paymentUrl), 'declined');
    const a = await attempts(d.id);
    expect(a.map((x) => x.status)).toEqual(['declined', 'pending']);
    expect(a[1].redirect_url).toBeTruthy();
    expect(a[1].redirect_url).not.toBe(d.paymentUrl);
    const ev = (await deliveries()).find((x) => x.event === 'deposit.payment_url_changed');
    expect(ev.payload.data.paymentUrl).toBe(a[1].redirect_url);
  });

  it('отказ на всех аккаунтах → окончательный отказ и уведомление сайту', async () => {
    await account('A', 100);
    randoms.push(0.1); // единственный аккаунт отказал сразу
    const d = await deposit();
    expect(d).toMatchObject({ status: 'declined', declineCode: 'all_attempts_failed', paymentUrl: null });
    expect((await deliveries()).map((x) => x.event)).toEqual(['deposit.declined']);
  });

  it('оплата по уже закрытой попытке фиксируется как расхождение для ручного разбора', async () => {
    await account('A', 100);
    await account('B', 200);
    const d = await deposit();
    const oldRef = refOf(d.paymentUrl);
    await mock.complete(oldRef, 'declined'); // каскад на B
    // Провайдер A «передумал»: платёж всё-таки прошёл
    const p = mock.payments.get(oldRef)!;
    p.status = 'success';
    await mock.sendWebhook(p);
    const issues = (await pool.query(`SELECT kind FROM reconciliation_issues`)).rows;
    expect(issues).toEqual([{ kind: 'late_success' }]);
    expect((await tx(d.id)).status).toBe('pending'); // деньги автоматически не двигаем
  });

  it('оплачена не та сумма — платёж не зачисляется, создаётся проблема, сверка его больше не трогает', async () => {
    await account('A', 100);
    const d = await deposit(5000);
    const ref = refOf(d.paymentUrl);
    mock.payments.get(ref)!.amount = 500n; // у провайдера «оплатили» 5.00 вместо 50.00
    await mock.complete(ref, 'success');
    expect((await tx(d.id)).status).toBe('pending');
    expect(await ledgerCount()).toBe(0);
    const issues = (await pool.query(`SELECT kind, details FROM reconciliation_issues`)).rows;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'amount_mismatch' });
    expect(issues[0].details).toMatch(/50\.00 EUR.*5\.00/);
    await pool.query(`UPDATE transaction_attempts SET submitted_at = now() - interval '10 minutes'`);
    expect((await reconcilePending({ pool, providers, secrets }, 60)).checked).toBe(0);
    await mock.sendWebhook(mock.payments.get(ref)!); // повторный вебхук не плодит проблемы
    expect((await pool.query(`SELECT count(*)::int c FROM reconciliation_issues`)).rows[0].c).toBe(1);
  });

  // ---------- сверка ----------

  it('потерянный вебхук: сверка сама узнаёт статус у провайдера', async () => {
    await account('A', 100);
    const d = await deposit();
    mock.sink = null; // вебхук «потерялся»
    await mock.complete(refOf(d.paymentUrl), 'success');
    expect((await tx(d.id)).status).toBe('pending');
    await pool.query(`UPDATE transaction_attempts SET submitted_at = now() - interval '10 minutes'`);
    expect(await reconcilePending({ pool, providers, secrets }, 300)).toEqual({ checked: 1, resolved: 1 });
    expect((await tx(d.id)).status).toBe('success');
  });

  it('провайдер недоступен при отправке: платёж ждёт, сверка переводит его на другой аккаунт', async () => {
    const accA = await account('A', 100);
    await account('B', 200);
    const real = new MockAdapter(mock);
    let failFor: string | null = accA;
    const flaky: ProviderAdapter = {
      name: 'mock', manifest: real.manifest,
      createPayment: async (c, r) => { if (c.accountId === failFor) throw new Error('ETIMEDOUT'); return real.createPayment(c, r); },
      getStatus: (c, ref) => real.getStatus(c, ref),
      verifyWebhook: (c, h, b) => real.verifyWebhook(c, h, b),
    };
    providers.register(flaky);
    const d = await deposit();
    expect(d).toMatchObject({ status: 'pending', paymentUrl: null });
    expect((await attempts(d.id))[0].error).toMatch(/ETIMEDOUT/);
    failFor = null;
    await pool.query(`UPDATE transaction_attempts SET submitted_at = now() - interval '10 minutes'`);
    await reconcilePending({ pool, providers, secrets }, 300);
    const a = await attempts(d.id);
    expect(a.map((x) => [x.name, x.status])).toEqual([['A', 'declined'], ['B', 'pending']]);
    expect(a[1].redirect_url).toBeTruthy();
  });

  // ---------- доставка вебхуков сайтам ----------

  it('сайт недоступен → повтор с паузой, после восстановления доставлено', async () => {
    await account('A', 100);
    const d = await deposit();
    await mock.complete(refOf(d.paymentUrl), 'success');

    const down = captureFetch(503);
    expect(await dispatchOnce({ pool, encryptionKey: ENC_KEY, fetch: down.f })).toEqual({ delivered: 0, failed: 1 });
    let row = (await deliveries())[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'HTTP 503' });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    // до наступления паузы повторно не отправляется
    expect(await dispatchOnce({ pool, encryptionKey: ENC_KEY, fetch: down.f })).toEqual({ delivered: 0, failed: 0 });

    await pool.query(`UPDATE webhook_deliveries SET next_attempt_at = now()`);
    const up = captureFetch(200);
    await dispatchOnce({ pool, encryptionKey: ENC_KEY, fetch: up.f });
    row = (await deliveries())[0];
    expect(row).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it(`после ${MAX_DELIVERY_ATTEMPTS} неудач доставка помечается failed`, async () => {
    await account('A', 100);
    const d = await deposit();
    await mock.complete(refOf(d.paymentUrl), 'success');
    await pool.query(`UPDATE webhook_deliveries SET attempts = $1 - 1`, [MAX_DELIVERY_ATTEMPTS]);
    await dispatchOnce({ pool, encryptionKey: ENC_KEY, fetch: captureFetch(500).f });
    expect((await deliveries())[0].status).toBe('failed');
  });

  it('сайт без адреса вебхука не получает событий в очередь', async () => {
    await pool.query(`UPDATE sites SET webhook_url = NULL`);
    await account('A', 100);
    const d = await deposit();
    await mock.complete(refOf(d.paymentUrl), 'success');
    expect(await deliveries()).toHaveLength(0);
  });
});
