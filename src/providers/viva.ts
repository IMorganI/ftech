import { timingSafeEqual } from 'node:crypto';
import {
  InvalidWebhookError,
  type AccountCredentials, type CreatePaymentRequest, type CreatePaymentResult,
  type ProviderAdapter, type ProviderStatus, type VerifiedWebhook, type RefundRequest, type RefundResult,
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
  webhookToken: string;
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
  Amount: number;
  TransactionType?: { TransactionTypeId: number; Name?: string };
}

export class VivaError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export function parseVivaCredentials(secret: string): VivaCredentials {
  let c: Partial<VivaCredentials>;
  try { c = JSON.parse(secret); } catch { throw new Error('Секрет Viva должен быть JSON (см. docs/VIVA.md)'); }
  const missing = (['clientId', 'clientSecret', 'merchantId', 'apiKey', 'webhookToken'] as const).filter((k) => !c[k]);
  if (missing.length) throw new Error(`В секрете Viva не хватает: ${missing.join(', ')}`);
  if (c.env !== 'demo' && c.env !== 'live') throw new Error('В секрете Viva поле env должно быть "demo" или "live"');
  if (c.webhookToken!.length < 24) throw new Error('webhookToken в секрете Viva — минимум 24 символа');
  return c as VivaCredentials;
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

export class VivaAdapter implements ProviderAdapter {
  readonly name = 'viva';
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private http: HttpFetch;

  constructor(opts: { fetch?: HttpFetch; timeoutMs?: number } = {}) {
    const timeout = opts.timeoutMs ?? 10_000;
    const f = opts.fetch ?? (globalThis.fetch as unknown as HttpFetch);
    this.http = (url, init) => f(url, { ...init, signal: AbortSignal.timeout(timeout) });
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

    const token = await this.token(c);
    const body: Record<string, unknown> = {
      amount: Number(req.amount),            // в минорных единицах (центах), как и у нас
      customerTrns: 'Пополнение счёта',
      merchantTrns: req.reference,           // наш ID попытки — вернётся в вебхуке и отчётах Viva
    };
    if (c.sourceCode) body.sourceCode = c.sourceCode;

    const res = await this.http(`${HOSTS[c.env].api}/checkout/v2/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 401) this.tokens.delete(`${c.env}:${c.clientId}`);
    // 4xx — Viva явно отказала (неверные данные, источник не настроен): это отказ, каскад пойдёт дальше.
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
      return { kind: 'declined', reason: `viva_http_${res.status}: ${vivaErrorText(res.status, text)}` };
    }
    // 5xx, 401, 429, сеть — не знаем, создан ли заказ: исключение, попытку разберёт сверка.
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

  async getStatus(creds: AccountCredentials, providerRef: string): Promise<ProviderStatus> {
    const { state } = await this.order(creds, providerRef);
    switch (state) {
      case 3: return 'success';
      case 1: case 2: return 'declined';
      case 0: return 'pending';
      default: throw new VivaError(`Viva order status: неизвестный StateId (${state})`);
    }
  }

  async paidAmount(creds: AccountCredentials, providerRef: string): Promise<bigint | null> {
    return (await this.order(creds, providerRef)).amount;
  }

  /**
   * Возврат на карту: находим платёжную транзакцию заказа (CardCharge, статус F) и вызываем
   * DELETE /api/transactions/<id>/?amount=<центы>. Частичный возврат разрешён, но не больше суммы оплаты.
   */
  async refund(creds: AccountCredentials, req: RefundRequest): Promise<RefundResult> {
    const c = parseVivaCredentials(creds.secret);
    if (!/^\d{6,20}$/.test(req.providerRef)) return { kind: 'declined', reason: 'неверный код заказа' };
    const auth = { authorization: basic(c.merchantId, c.apiKey) };

    const list = await this.http(`${HOSTS[c.env].www}/api/transactions?ordercode=${req.providerRef}`, { method: 'GET', headers: auth });
    const listText = await list.text();
    if (!list.ok) throw new VivaError(`Viva transactions: HTTP ${list.status}`, list.status);
    const txs = (JSON.parse(listText) as { Transactions?: VivaTransaction[] }).Transactions ?? [];
    const charge = txs.find((t) => t.StatusId === 'F' && t.TransactionType?.TransactionTypeId === 5);
    if (!charge) return { kind: 'declined', reason: 'у заказа нет успешной оплаты для возврата' };

    const qs = new URLSearchParams({ amount: req.amount.toString() });
    if (c.sourceCode) qs.set('sourceCode', c.sourceCode);
    const res = await this.http(`${HOSTS[c.env].www}/api/transactions/${charge.TransactionId}/?${qs}`, { method: 'DELETE', headers: auth });
    const text = await res.text();
    let body: { Success?: boolean; StatusId?: string; TransactionId?: string; ErrorText?: string | null; ErrorCode?: number } = {};
    try { body = JSON.parse(text); } catch { /* пусто или не JSON */ }
    if (res.status >= 500 || res.status === 429 || res.status === 401) throw new VivaError(`Viva refund: HTTP ${res.status}`, res.status);
    if (res.ok && body.Success !== false && body.StatusId === 'F') return { kind: 'success', refundRef: body.TransactionId };
    return { kind: 'declined', reason: `viva_refund: ${body.ErrorText ?? vivaErrorText(res.status, text)}`.slice(0, 300) };
  }

  verifyWebhook(creds: AccountCredentials, _headers: Record<string, string | string[] | undefined>, rawBody: string,
    query: Record<string, unknown> = {}): VerifiedWebhook {
    const c = parseVivaCredentials(creds.secret);
    this.checkToken(c, query);
    const orderCode = extractNumber(rawBody, 'OrderCode');
    const messageId = /"MessageId"\s*:\s*"([^"]{1,100})"/i.exec(rawBody)?.[1];
    if (!orderCode || !messageId) throw new InvalidWebhookError('В вебхуке Viva нет OrderCode или MessageId');
    // Статус из тела не используется: система сама спросит Viva через getStatus.
    return { eventId: messageId, providerRef: orderCode };
  }

  /** GET-проверка адреса вебхука при настройке в кабинете Viva: отдаём их ключ. */
  async webhookChallenge(creds: AccountCredentials, query: Record<string, unknown> = {}): Promise<unknown> {
    const c = parseVivaCredentials(creds.secret);
    this.checkToken(c, query);
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
    const want = Buffer.from(c.webhookToken);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new InvalidWebhookError('Неверный токен вебхука');
  }
}
