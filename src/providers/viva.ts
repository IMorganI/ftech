import { timingSafeEqual } from 'node:crypto';
import {
  InvalidWebhookError, NotSentError,
  type AccountCredentials, type CreatePaymentRequest, type CreatePaymentResult,
  type ProviderAdapter, type ProviderStatus, type VerifiedWebhook, type RefundRequest, type RefundResult,
  type CredentialField, type ConnectionCheck, type ProviderManifest, type ProviderPayment,
} from './types.js';

/*
 * Адаптер Viva Wallet (Smart Checkout).
 *
 * Поток:
 *  1. OAuth2 client_credentials → access_token (кэшируется до истечения).
 *  2. POST /checkout/v2/orders → orderCode. Игрок платит на странице Viva: /web/checkout?ref=<orderCode>.
 *     Номера карт к нам не попадают.
 *  3. Статус заказа: GET /api/orders/<orderCode> (Basic: Merchant ID + API Key) → StateId
 *     0 — ждёт оплаты, 1 — истёк, 2 — отменён, 3 — оплачен.
 *  4. Вебхуки Viva НЕ подписаны. Поэтому: (а) адрес вебхука закрыт секретным токеном (?token=…),
 *     (б) из тела берём только OrderCode и MessageId, а статус всегда перепроверяем запросом к Viva (п. 3).
 *     При настройке вебхука Viva делает GET на адрес и ждёт {"Key": "..."} — см. webhookChallenge().
 *
 * Секрет аккаунта (PROVIDER_SECRET_<REF>) — JSON:
 *   { "env": "demo" | "live", "clientId", "clientSecret", "merchantId", "apiKey",
 *     "sourceCode"?, "currency"?: "EUR", "webhookToken" }
 */

export interface VivaCredentials {
  env: 'demo' | 'live';
  clientId: string;
  clientSecret: string;
  merchantId: string;
  apiKey: string;
  sourceCode?: string;
  currency?: string;
  /** Старый формат: токен адреса вебхука лежал в ключах. Теперь он у аккаунта (webhook_token). */
  webhookToken?: string;
}

const HOSTS = {
  demo: { accounts: 'https://demo-accounts.vivapayments.com', api: 'https://demo-api.vivapayments.com', www: 'https://demo.vivapayments.com' },
  live: { accounts: 'https://accounts.vivapayments.com', api: 'https://api.vivapayments.com', www: 'https://www.vivapayments.com' },
} as const;

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface VivaTransaction {
  TransactionId: string;
  StatusId: string;
  Amount: number | string;
  /** Числовой код ISO 4217 строкой ("978") */
  CurrencyCode?: string | number;
  TransactionType?: { TransactionTypeId: number; Name?: string };
}

export class VivaError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export function parseVivaCredentials(secret: string): VivaCredentials {
  let c: Partial<VivaCredentials>;
  try { c = JSON.parse(secret); } catch { throw new Error('Секрет Viva должен быть JSON (см. docs/VIVA.md)'); }
  const missing = (['clientId', 'clientSecret', 'merchantId', 'apiKey'] as const).filter((k) => !c[k]);
  if (missing.length) throw new Error(`В секрете Viva не хватает: ${missing.join(', ')}`);
  if (c.env !== 'demo' && c.env !== 'live') throw new Error('В секрете Viva поле env должно быть "demo" или "live"');
  if (c.webhookToken !== undefined && c.webhookToken.length < 24) throw new Error('webhookToken в секрете Viva — минимум 24 символа');
  return c as VivaCredentials;
}

/** Сумма Viva в единицах валюты (10.5 → 1050 центов). Строкой, без float. */
export function parseDecimalAmount(v: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2})\d*)?$/.exec(v.trim());
  return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0')) : null;
}

/** Viva отдаёт валюту числовым кодом ISO 4217 (978 = EUR). Неизвестный код — null (платёж уйдёт на проверку). */
const ISO_NUMERIC: Record<string, string> = {
  '978': 'EUR', '840': 'USD', '826': 'GBP', '985': 'PLN', '946': 'RON', '203': 'CZK', '348': 'HUF', '752': 'SEK',
  '208': 'DKK', '578': 'NOK', '975': 'BGN', '756': 'CHF', '980': 'UAH',
};
export function currencyFromViva(code: unknown): string | null {
  if (typeof code === 'number') code = String(code);
  if (typeof code !== 'string') return null;
  if (/^[A-Z]{3}$/.test(code)) return code;
  return ISO_NUMERIC[code.padStart(3, '0')] ?? null;
}

/** RequestAmount Viva — десятичное число в единицах валюты (5.00 = 500 центов). Разбираем строкой, без float. */
export function parseVivaAmount(text: string): bigint | null {
  const m = /"RequestAmount"\s*:\s*"?(\d{1,15})(?:\.(\d{1,2})\d*)?"?/i.exec(text);
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

/** orderCode — 16-значное число: достаём строкой, чтобы не потерять точность в JSON.parse. */
function extractNumber(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"?(\\d{6,20})"?`, 'i').exec(text);
  return m ? m[1]! : null;
}

/** Понятная причина отказа Viva для борды: их сообщение или подсказка по коду. */
export function vivaErrorText(status: number, body: string): string {
  let msg = '';
  try {
    const j = JSON.parse(body) as { message?: unknown; Message?: unknown; errorText?: unknown; ErrorText?: unknown };
    msg = String(j.message ?? j.Message ?? j.errorText ?? j.ErrorText ?? '');
  } catch { /* не JSON */ }
  if (msg && msg !== 'null') return msg.replace(/\s+/g, ' ').slice(0, 200);
  if (status === 403) return 'нет прав на создание заказа — проверь, что ключи из блока Smart Checkout Credentials';
  if (status === 404) return 'не найдено — проверь env (demo/live) и код источника платежей';
  if (status === 400) return 'Viva отклонила параметры заказа (сумма, валюта или код источника)';
  return 'Viva вернула ошибку без пояснения';
}

const VIVA_FIELDS: CredentialField[] = [
  { key: 'env', label: 'Режим', options: ['demo', 'live'], default: 'demo', required: true, help: 'demo — тестовый кабинет Viva, live — боевой' },
  { key: 'clientId', label: 'Client ID', required: true, placeholder: '….apps.vivapayments.com',
    help: 'Settings → API Access → Smart Checkout Credentials (не POS/ECR и не Native Checkout)' },
  { key: 'clientSecret', label: 'Client Secret', secret: true, required: true, help: 'Там же, Smart Checkout Credentials' },
  { key: 'merchantId', label: 'Merchant ID', required: true, help: 'Settings → API Access → General' },
  { key: 'apiKey', label: 'API Key', secret: true, required: true, help: 'Settings → API Access → General' },
  { key: 'sourceCode', label: 'Код источника платежей', placeholder: 'не обязательно', help: 'Sales → Online Payments → Websites/Apps. Пусто — источник Default' },
  { key: 'currency', label: 'Валюта аккаунта', default: 'EUR', required: true },
];

/** Срок оплаты заказа Viva, секунды. Задаём явно: от него зависит, когда можно закрыть потерянную отправку. */
export const VIVA_PAYMENT_TTL_SEC = 1800;

export class VivaAdapter implements ProviderAdapter {
  readonly name = 'viva';
  readonly paymentTtlSec = VIVA_PAYMENT_TTL_SEC;
  readonly manifest: ProviderManifest = {
    title: 'Viva Wallet (Smart Checkout)',
    summary: 'Европейский эквайер: игрок платит на странице Viva, карты к нам не попадают.',
    methods: ['Visa / Mastercard', 'Apple Pay', 'Google Pay'],
    links: { dashboard: 'https://demo.vivapayments.com', docs: 'https://developer.viva.com/smart-checkout/' },
    fields: VIVA_FIELDS,
    capabilities: { refunds: true, partialRefunds: true, amountCheck: true },
    webhook: {
      scheme: 'token',
      events: ['Transaction Payment Created', 'Transaction Failed'],
      steps: [
        'Открой кабинет Viva → Settings → API Access → Webhooks',
        'Create Webhook: вставь адрес ниже',
        'Отметь события Transaction Payment Created и Transaction Failed',
        'Нажми Verify, сохрани и проверь, что статус Active',
      ],
      note: 'Viva не подписывает вебхуки: защищает токен в адресе, а статус платежа мы всё равно перепроверяем у Viva. При нажатии Verify Viva проверит адрес запросом — сервер ответит сам.',
    },
  };
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private http: HttpFetch;

  constructor(opts: { fetch?: HttpFetch; timeoutMs?: number } = {}) {
    const timeout = opts.timeoutMs ?? 10_000;
    const f = opts.fetch ?? (globalThis.fetch as unknown as HttpFetch);
    this.http = (url, init) => f(url, { ...init, signal: AbortSignal.timeout(timeout) });
  }

  /** Проверка ключей без создания платежей. */
  async checkConnection(creds: AccountCredentials): Promise<ConnectionCheck[]> {
    let c: VivaCredentials;
    try { c = parseVivaCredentials(creds.secret); } catch (err) {
      return [{ name: 'Ключи заполнены', ok: false, message: (err as Error).message }];
    }
    const checks: ConnectionCheck[] = [];
    try {
      const res = await this.http(`${HOSTS[c.env].accounts}/connect/token`, {
        method: 'POST',
        headers: { authorization: basic(c.clientId, c.clientSecret), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      const text = await res.text();
      if (!res.ok) {
        checks.push({ name: 'Client ID и Client Secret', ok: false,
          message: res.status === 400 || res.status === 401 ? `Viva не принимает эту пару (HTTP ${res.status}). Проверь, что режим ${c.env} совпадает с кабинетом` : `Viva ответила HTTP ${res.status}` });
      } else {
        const scope = String((JSON.parse(text) as { scope?: string }).scope ?? '');
        checks.push({ name: 'Client ID и Client Secret', ok: true, message: 'Viva выдаёт токен' });
        checks.push(scope.includes('redirectcheckout')
          ? { name: 'Права на онлайн-оплату', ok: true, message: 'Ключи от Smart Checkout' }
          : { name: 'Права на онлайн-оплату', ok: false,
              message: `Это ключи не от Smart Checkout (права: ${scope || 'нет'}). Создай их в блоке Smart Checkout Credentials` });
      }
    } catch (err) {
      checks.push({ name: 'Client ID и Client Secret', ok: false, message: `Нет связи с Viva: ${(err as Error).message}` });
    }
    try {
      const res = await this.http(`${HOSTS[c.env].www}/api/messages/config/token`, { method: 'GET', headers: { authorization: basic(c.merchantId, c.apiKey) } });
      await res.text();
      checks.push(res.ok
        ? { name: 'Merchant ID и API Key', ok: true, message: 'Доступ к статусам и возвратам есть' }
        : { name: 'Merchant ID и API Key', ok: false, message: `Viva не принимает эту пару (HTTP ${res.status}). Без неё не будут работать статусы, возвраты и вебхуки` });
    } catch (err) {
      checks.push({ name: 'Merchant ID и API Key', ok: false, message: `Нет связи с Viva: ${(err as Error).message}` });
    }
    return checks;
  }

  private async token(c: VivaCredentials): Promise<string> {
    const key = `${c.env}:${c.clientId}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const res = await this.http(`${HOSTS[c.env].accounts}/connect/token`, {
      method: 'POST',
      headers: { authorization: basic(c.clientId, c.clientSecret), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    if (!res.ok) throw new VivaError(`Viva OAuth: HTTP ${res.status}`, res.status);
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new VivaError('Viva OAuth: нет access_token');
    this.tokens.set(key, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 });
    return body.access_token;
  }

  async createPayment(creds: AccountCredentials, req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const c = parseVivaCredentials(creds.secret);
    const currency = (c.currency ?? 'EUR').toUpperCase();
    if (req.currency !== currency) return { kind: 'declined', reason: `currency_not_supported:${req.currency}` };
    if (req.amount > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'declined', reason: 'amount_too_large' };

    let token: string;
    try { token = await this.token(c); } catch (err) {
      // Токен не получен — заказ ещё не отправляли: можно идти на другой аккаунт.
      throw new NotSentError(`Viva: не удалось получить токен (${(err as Error).message})`);
    }
    const body: Record<string, unknown> = {
      amount: Number(req.amount),            // в минорных единицах (центах), как и у нас
      customerTrns: 'Пополнение счёта',
      merchantTrns: req.reference,           // наш ID попытки — вернётся в вебхуке и отчётах Viva
      paymentTimeout: VIVA_PAYMENT_TTL_SEC,   // явный срок оплаты заказа: после него оплатить нельзя
    };
    if (c.sourceCode) body.sourceCode = c.sourceCode;

    const res = await this.http(`${HOSTS[c.env].api}/checkout/v2/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 401) this.tokens.delete(`${c.env}:${c.clientId}`);
    // 4xx — Viva явно отказала (неверные данные, источник не настроен, авторизация 401, лимит частоты 429):
    // заказ не создан, это отказ — каскад пойдёт дальше.
    if (res.status >= 400 && res.status < 500) {
      return { kind: 'declined', reason: `viva_http_${res.status}: ${vivaErrorText(res.status, text)}` };
    }
    // 5xx, сеть — не знаем, создан ли заказ: исключение, попытку разберёт сверка.
    if (!res.ok) throw new VivaError(`Viva create order: HTTP ${res.status}`, res.status);
    const orderCode = extractNumber(text, 'orderCode');
    if (!orderCode) throw new VivaError('Viva create order: в ответе нет orderCode');
    return { kind: 'redirect', providerRef: orderCode, redirectUrl: `${HOSTS[c.env].www}/web/checkout?ref=${orderCode}` };
  }

  /** Заказ Viva: GET /api/orders/<orderCode> → StateId и RequestAmount (в евро с копейками, например 5.00). */
  private async order(creds: AccountCredentials, providerRef: string): Promise<{ state: number; amount: bigint | null }> {
    const c = parseVivaCredentials(creds.secret);
    if (!/^\d{6,20}$/.test(providerRef)) throw new VivaError('Неверный orderCode');
    const res = await this.http(`${HOSTS[c.env].www}/api/orders/${providerRef}`, {
      method: 'GET', headers: { authorization: basic(c.merchantId, c.apiKey) },
    });
    const text = await res.text();
    if (!res.ok) throw new VivaError(`Viva order status: HTTP ${res.status}`, res.status);
    const state = Number(/"StateId"\s*:\s*(\d+)/i.exec(text)?.[1] ?? NaN);
    return { state, amount: parseVivaAmount(text) };
  }

  /**
   * Статус заказа (GET /api/orders) и, для оплаченного, фактическая оплата: платёжная транзакция заказа
   * (CardCharge, статус F) из GET /api/transactions — её сумма, валюта и ID.
   */
  async getPayment(creds: AccountCredentials, providerRef: string): Promise<ProviderPayment> {
    const { state } = await this.order(creds, providerRef);
    switch (state) {
      case 0: return { status: 'pending', amount: null, currency: null };
      case 1: case 2: return { status: 'declined', amount: null, currency: null };
      case 3: break;
      default: throw new VivaError(`Viva order status: неизвестный StateId (${state})`);
    }
    const charge = await this.charge(parseVivaCredentials(creds.secret), providerRef);
    if (!charge) return { status: 'success', amount: null, currency: null };
    return {
      status: 'success',
      amount: typeof charge.Amount === 'number' || typeof charge.Amount === 'string' ? parseDecimalAmount(String(charge.Amount)) : null,
      currency: currencyFromViva(charge.CurrencyCode),
      operationId: charge.TransactionId ?? null,
    };
  }

  /** Успешная платёжная транзакция заказа (CardCharge, StatusId F) или null. */
  private async charge(c: VivaCredentials, orderCode: string): Promise<VivaTransaction | null> {
    const list = await this.http(`${HOSTS[c.env].www}/api/transactions?ordercode=${orderCode}`, {
      method: 'GET', headers: { authorization: basic(c.merchantId, c.apiKey) } });
    const text = await list.text();
    if (!list.ok) throw new VivaError(`Viva transactions: HTTP ${list.status}`, list.status);
    const txs = (JSON.parse(text) as { Transactions?: VivaTransaction[] }).Transactions ?? [];
    return txs.find((t) => t.StatusId === 'F' && t.TransactionType?.TransactionTypeId === 5) ?? null;
  }

  /**
   * Возврат на карту: находим платёжную транзакцию заказа (CardCharge, статус F) и вызываем
   * DELETE /api/transactions/<id>/?amount=<центы>. Частичный возврат разрешён, но не больше суммы оплаты.
   * Viva возвращает деньги из доступного баланса мерчанта: если он пуст — отказ, часть выплаты станет ручной.
   */
  async refund(creds: AccountCredentials, req: RefundRequest): Promise<RefundResult> {
    const c = parseVivaCredentials(creds.secret);
    if (!/^\d{6,20}$/.test(req.providerRef)) return { kind: 'declined', reason: 'неверный код заказа' };
    const auth = { authorization: basic(c.merchantId, c.apiKey) };

    let charge;
    try { charge = await this.charge(c, req.providerRef); } catch (err) {
      throw new NotSentError(`Viva: не удалось найти оплату для возврата (${(err as Error).message})`); // возврат не отправлялся
    }
    if (!charge) return { kind: 'declined', reason: 'у заказа нет успешной оплаты для возврата' };

    const qs = new URLSearchParams({ amount: req.amount.toString() });
    if (c.sourceCode) qs.set('sourceCode', c.sourceCode);
    const res = await this.http(`${HOSTS[c.env].www}/api/transactions/${charge.TransactionId}/?${qs}`, { method: 'DELETE', headers: auth });
    const text = await res.text();
    let body: { Success?: boolean; StatusId?: string; TransactionId?: string; ErrorText?: string | null; ErrorCode?: number } = {};
    try { body = JSON.parse(text); } catch { /* пусто или не JSON */ }
    // 401/429 — Viva не выполняла запрос: возврат точно не прошёл, его можно повторить позже.
    if (res.status === 429 || res.status === 401) throw new NotSentError(`Viva refund: HTTP ${res.status}`);
    if (res.status >= 500) throw new VivaError(`Viva refund: HTTP ${res.status}`, res.status);
    // Успех — только явный: Success = true и ErrorCode = 0 (HTTP 200 бывает и при отказе).
    if (res.ok && body.Success === true && (body.ErrorCode ?? 0) === 0) return { kind: 'success', refundRef: body.TransactionId };
    const known: Record<string, string> = {
      PaymentsInsufficientFundsForReversal: 'на балансе Viva недостаточно средств для возврата (оплаты ещё не прошли клиринг или баланс выведен)',
      PaymentsInvalidAmountForVoid: 'сумма возврата больше невозвращённой части оплаты',
      PaymentsNonReversibleTransaction: 'оплата уже возвращена или не подлежит возврату',
    };
    const err = body.ErrorText ?? '';
    return { kind: 'declined', reason: `viva_refund: ${known[err] ? `${known[err]} (${err})` : err || vivaErrorText(res.status, text)}`.slice(0, 300) };
  }

  verifyWebhook(creds: AccountCredentials, _headers: Record<string, string | string[] | undefined>, rawBody: string,
    query: Record<string, unknown> = {}): VerifiedWebhook {
    const c = parseVivaCredentials(creds.secret);
    if (c.webhookToken) this.checkToken(c, query); // старый формат ключей; основную проверку токена делает ядро
    const orderCode = extractNumber(rawBody, 'OrderCode');
    const messageId = /"MessageId"\s*:\s*"([^"]{1,100})"/i.exec(rawBody)?.[1];
    if (!orderCode || !messageId) throw new InvalidWebhookError('В вебхуке Viva нет OrderCode или MessageId');
    // Статус из тела не используется: система сама спросит Viva через getStatus.
    return { eventId: messageId, providerRef: orderCode };
  }

  /** GET-проверка адреса вебхука при настройке в кабинете Viva: отдаём их ключ. */
  async webhookChallenge(creds: AccountCredentials, query: Record<string, unknown> = {}): Promise<unknown> {
    const c = parseVivaCredentials(creds.secret);
    if (c.webhookToken) this.checkToken(c, query);
    const res = await this.http(`${HOSTS[c.env].www}/api/messages/config/token`, {
      method: 'GET', headers: { authorization: basic(c.merchantId, c.apiKey) },
    });
    const text = await res.text();
    if (!res.ok) throw new VivaError(`Viva webhook key: HTTP ${res.status}`, res.status);
    const key = (JSON.parse(text) as { Key?: string; key?: string });
    return { Key: key.Key ?? key.key };
  }

  private checkToken(c: VivaCredentials, query: Record<string, unknown>) {
    const got = Buffer.from(String(query.token ?? ''));
    const want = Buffer.from(c.webhookToken ?? '');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new InvalidWebhookError('Неверный токен вебхука');
  }
}
