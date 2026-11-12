import { randomUUID } from 'node:crypto';
import { hmacHex, safeEqualHex } from '../crypto.js';
import {
  InvalidWebhookError,
  type AccountCredentials, type CreatePaymentRequest, type CreatePaymentResult,
  type ProviderAdapter, type ProviderStatus, type VerifiedWebhook, type RefundRequest, type RefundResult,
} from './types.js';

/*
 * Мок-провайдер для разработки и тестов. Ведёт себя как настоящий:
 *  - иногда сразу отклоняет платёж (instantDeclineRate);
 *  - отдаёт ссылку на «страницу оплаты», где игрок жмёт «Оплатить» или «Отклонить»;
 *  - присылает подписанный вебхук, иногда дважды (duplicateWebhookRate);
 *  - по запросу отдаёт статус платежа.
 * Работает в том же процессе; настоящий адаптер вместо симулятора ходит по HTTP в API провайдера.
 */

export interface MockPayment {
  ref: string;
  accountId: string;
  secret: string;
  reference: string;
  amount: bigint;
  currency: string;
  returnUrl: string | null;
  status: ProviderStatus;
  refunded: bigint;
}

export interface MockOptions {
  instantDeclineRate?: number;
  duplicateWebhookRate?: number;
  refundDeclineRate?: number;
  random?: () => number;
  /** Адрес, с которого открывается страница оплаты, например https://api.example.com */
  publicBaseUrl: string;
}

/** Как симулятор доставляет вебхук (в разработке — HTTP-запрос в наш же сервер). */
export type WebhookSink = (accountId: string, headers: Record<string, string>, rawBody: string) => Promise<void>;

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
export const MOCK_TIMESTAMP_HEADER = 'x-mock-timestamp';
const MAX_WEBHOOK_AGE_SEC = 300;

export class MockProvider {
  readonly payments = new Map<string, MockPayment>();
  sink: WebhookSink | null = null;
  private random: () => number;

  constructor(private opts: MockOptions) {
    this.random = opts.random ?? Math.random;
  }

  create(creds: AccountCredentials, req: CreatePaymentRequest): CreatePaymentResult {
    if (this.random() < (this.opts.instantDeclineRate ?? 0)) {
      return { kind: 'declined', reason: 'do_not_honor' };
    }
    const ref = 'mock_' + randomUUID().replace(/-/g, '');
    this.payments.set(ref, {
      ref, accountId: creds.accountId, secret: creds.secret, reference: req.reference,
      amount: req.amount, currency: req.currency, returnUrl: req.returnUrl, status: 'pending', refunded: 0n,
    });
    return { kind: 'redirect', providerRef: ref, redirectUrl: `${this.opts.publicBaseUrl}/mock-provider/pay/${ref}` };
  }

  /** Возврат: только по оплаченному и не больше невозвращённого остатка. */
  refund(ref: string, amount: bigint): RefundResult {
    if (this.random() < (this.opts.refundDeclineRate ?? 0)) return { kind: 'declined', reason: 'refund_not_allowed' };
    const p = this.payments.get(ref);
    if (!p || p.status !== 'success') return { kind: 'declined', reason: 'payment_not_found' };
    if (p.refunded + amount > p.amount) return { kind: 'declined', reason: 'amount_exceeds_payment' };
    p.refunded += amount;
    return { kind: 'success', refundRef: 'mock_rf_' + randomUUID().slice(0, 8) };
  }

  status(ref: string): ProviderStatus {
    const p = this.payments.get(ref);
    if (!p) throw new Error(`Мок-платёж ${ref} не найден`);
    return p.status;
  }

  /** Игрок завершил оплату на странице провайдера. */
  async complete(ref: string, outcome: 'success' | 'declined'): Promise<MockPayment> {
    const p = this.payments.get(ref);
    if (!p) throw new Error(`Мок-платёж ${ref} не найден`);
    if (p.status !== 'pending') return p;
    p.status = outcome;
    const send = () => this.sendWebhook(p);
    await send();
    if (this.random() < (this.opts.duplicateWebhookRate ?? 0)) await send();
    return p;
  }

  async sendWebhook(p: MockPayment, eventId: string = randomUUID()): Promise<void> {
    if (!this.sink) return;
    const body = JSON.stringify({ eventId, paymentRef: p.ref, reference: p.reference, status: p.status });
    await this.sink(p.accountId, signMockWebhook(p.secret, body), body);
  }
}

export function signMockWebhook(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    'content-type': 'application/json',
    [MOCK_TIMESTAMP_HEADER]: String(ts),
    [MOCK_SIGNATURE_HEADER]: hmacHex(secret, `${ts}.${body}`),
  };
}

export class MockAdapter implements ProviderAdapter {
  readonly name = 'mock';
  readonly title = 'Тестовый провайдер (без реальных денег)';
  readonly credentialFields = [];

  async checkConnection(): Promise<{ name: string; ok: boolean; message: string }[]> {
    return [{ name: 'Тестовый провайдер', ok: true, message: 'Ключи не нужны, оплата — на тестовой странице' }];
  }
  constructor(private provider: MockProvider) {}

  async createPayment(creds: AccountCredentials, req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    return this.provider.create(creds, req);
  }

  async getStatus(_creds: AccountCredentials, providerRef: string): Promise<ProviderStatus> {
    return this.provider.status(providerRef);
  }

  async refund(_creds: AccountCredentials, req: RefundRequest): Promise<RefundResult> {
    return this.provider.refund(req.providerRef, req.amount);
  }

  async paidAmount(_creds: AccountCredentials, providerRef: string): Promise<bigint | null> {
    return this.provider.payments.get(providerRef)?.amount ?? null;
  }

  verifyWebhook(creds: AccountCredentials, headers: Record<string, string | string[] | undefined>, rawBody: string): VerifiedWebhook {
    const sig = String(headers[MOCK_SIGNATURE_HEADER] ?? '');
    const ts = Number(headers[MOCK_TIMESTAMP_HEADER]);
    if (!sig || !Number.isFinite(ts)) throw new InvalidWebhookError('Нет подписи или метки времени');
    if (Math.abs(Date.now() / 1000 - ts) > MAX_WEBHOOK_AGE_SEC) throw new InvalidWebhookError('Вебхук слишком старый');
    if (!safeEqualHex(sig, hmacHex(creds.secret, `${ts}.${rawBody}`))) throw new InvalidWebhookError('Неверная подпись');
    let body: { eventId?: unknown; paymentRef?: unknown };
    try { body = JSON.parse(rawBody); } catch { throw new InvalidWebhookError('Тело не JSON'); }
    if (typeof body.eventId !== 'string' || typeof body.paymentRef !== 'string') {
      throw new InvalidWebhookError('Нет eventId или paymentRef');
    }
    return { eventId: body.eventId, providerRef: body.paymentRef };
  }
}
