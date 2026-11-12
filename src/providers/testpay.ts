import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  InvalidWebhookError,
  type AccountCredentials, type CreatePaymentRequest, type CreatePaymentResult, type ConnectionCheck,
  type ProviderAdapter, type ProviderManifest, type ProviderPayment, type ProviderStatus, type VerifiedWebhook, type RefundRequest, type RefundResult,
} from './types.js';

/*
 * TestPay — учебный провайдер, устроенный как большинство настоящих (Stripe, Checkout.com, Nuvei…):
 *  - в его «кабинете» (/testpay) создаёшь API-ключ;
 *  - вставляешь наш адрес вебхука — кабинет выдаёт секрет подписи whsec_…, его вводишь в борде;
 *  - вебхуки подписаны: заголовок testpay-signature: t=<время>,v1=<HMAC-SHA256(секрет, "t.тело")>;
 *  - есть кнопка «Отправить тестовое событие».
 * Нужен, чтобы проверить сценарий подключения с подписью без договора с реальным провайдером.
 * Работает только при MOCK_PROVIDER_ENABLED; доставляет вебхуки только на этот же сервер.
 */

export const TESTPAY_SIGNATURE_HEADER = 'testpay-signature';
const TOLERANCE_SEC = 300;

export interface TestPayEndpoint { url: string; secret: string; lastDelivery?: { at: string; status: number; event: string } }
interface TestPayKey { key: string; createdAt: string; endpoint?: TestPayEndpoint }
export interface TestPayPayment {
  id: string; apiKey: string; reference: string; amount: bigint; currency: string; returnUrl: string | null;
  status: ProviderStatus; refunded: bigint;
}

/** Как симулятор доставляет вебхук: (адрес, заголовки, тело) → HTTP-статус ответа. */
export type TestPayDeliver = (url: string, headers: Record<string, string>, body: string) => Promise<number>;

export function signTestPay(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
}

export class TestPaySimulator {
  readonly keys = new Map<string, TestPayKey>();
  readonly payments = new Map<string, TestPayPayment>();
  deliver: TestPayDeliver | null = null;

  /** stateFile — где хранить ключи и вебхуки между перезапусками (в разработке); без него — только в памяти. */
  constructor(readonly publicBaseUrl: string, private stateFile?: string) {
    if (stateFile) {
      try {
        for (const k of JSON.parse(readFileSync(stateFile, 'utf8')) as TestPayKey[]) this.keys.set(k.key, k);
      } catch { /* файла ещё нет */ }
    }
  }

  private save() {
    if (!this.stateFile) return;
    try { mkdirSync(dirname(this.stateFile), { recursive: true }); writeFileSync(this.stateFile, JSON.stringify([...this.keys.values()], null, 2)); }
    catch { /* не критично для симулятора */ }
  }

  createKey(): string {
    const key = `tp_test_${randomBytes(12).toString('hex')}`;
    this.keys.set(key, { key, createdAt: new Date().toISOString() });
    this.save();
    return key;
  }

  /** Сохранить адрес вебхука. Секрет выдаётся при первом сохранении и не меняется при смене адреса. */
  setEndpoint(key: string, url: string): TestPayEndpoint {
    const k = this.keys.get(key);
    if (!k) throw new Error('Нет такого API-ключа');
    k.endpoint = { url, secret: k.endpoint?.secret ?? `whsec_${randomBytes(18).toString('hex')}` };
    this.save();
    return k.endpoint;
  }

  rollSecret(key: string): void {
    const k = this.keys.get(key);
    if (k?.endpoint) { k.endpoint.secret = `whsec_${randomBytes(18).toString('hex')}`; this.save(); }
  }

  async sendEvent(key: string, type: string, data: Record<string, unknown>): Promise<number | null> {
    const ep = this.keys.get(key)?.endpoint;
    if (!ep || !this.deliver) return null;
    const body = JSON.stringify({ id: `evt_${randomUUID().replace(/-/g, '')}`, type, created: Math.floor(Date.now() / 1000), data },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    let status = 0;
    try { status = await this.deliver(ep.url, { 'content-type': 'application/json', [TESTPAY_SIGNATURE_HEADER]: signTestPay(ep.secret, body) }, body); }
    catch { status = 0; }
    ep.lastDelivery = { at: new Date().toISOString(), status, event: type };
    this.save();
    return status;
  }

  create(apiKey: string, req: CreatePaymentRequest): TestPayPayment {
    const id = `tp_pay_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const p: TestPayPayment = { id, apiKey, reference: req.reference, amount: req.amount, currency: req.currency,
      returnUrl: req.returnUrl, status: 'pending', refunded: 0n };
    this.payments.set(id, p);
    return p;
  }

  async complete(id: string, outcome: 'success' | 'declined'): Promise<TestPayPayment | null> {
    const p = this.payments.get(id);
    if (!p) return null;
    if (p.status !== 'pending') return p;
    p.status = outcome;
    await this.sendEvent(p.apiKey, outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
      { payment_id: p.id, reference: p.reference, amount: p.amount, currency: p.currency });
    return p;
  }
}

interface TestPayCreds { apiKey: string; webhookSecret?: string }

function parseCreds(secret: string): TestPayCreds {
  let c: Partial<TestPayCreds>;
  try { c = JSON.parse(secret); } catch { throw new Error('Ключи TestPay не заполнены'); }
  if (!c.apiKey) throw new Error('Не задан API-ключ TestPay');
  return c as TestPayCreds;
}

export class TestPayAdapter implements ProviderAdapter {
  readonly name = 'testpay';
  readonly manifest: ProviderManifest;

  constructor(private sim: TestPaySimulator) {
    this.manifest = {
      title: 'TestPay (учебный, с подписью вебхуков)',
      summary: 'Симулятор провайдера, устроенного как большинство настоящих: API-ключ, вебхук с секретом подписи, тестовое событие.',
      methods: ['Тестовая оплата'],
      links: { dashboard: `${sim.publicBaseUrl}/testpay` },
      fields: [
        { key: 'apiKey', label: 'API-ключ', secret: true, required: true, stage: 'keys', placeholder: 'tp_test_…',
          help: 'Кабинет TestPay → «Создать API-ключ»' },
        { key: 'webhookSecret', label: 'Секрет подписи вебхуков', secret: true, stage: 'webhook', placeholder: 'whsec_…',
          help: 'Появится в кабинете TestPay после сохранения адреса вебхука' },
      ],
      capabilities: { refunds: true, partialRefunds: true, amountCheck: true },
      webhook: {
        scheme: 'signature',
        events: ['payment.succeeded', 'payment.failed'],
        steps: [
          'Открой кабинет TestPay (ссылка выше)',
          'У своего API-ключа вставь адрес вебхука и нажми «Сохранить адрес»',
          'Скопируй появившийся секрет подписи (whsec_…) и вставь его в поле ниже',
          'В кабинете нажми «Отправить тестовое событие» — статус вебхука здесь станет зелёным',
        ],
        note: 'Секрет подписи выдаёт провайдер, а не мы: так устроено у большинства платёжек.',
      },
    };
  }

  async checkConnection(creds: AccountCredentials): Promise<ConnectionCheck[]> {
    let c: TestPayCreds;
    try { c = parseCreds(creds.secret); } catch (err) { return [{ name: 'API-ключ', ok: false, message: (err as Error).message }]; }
    const key = this.sim.keys.get(c.apiKey);
    const checks: ConnectionCheck[] = [key
      ? { name: 'API-ключ', ok: true, message: 'TestPay принимает ключ' }
      : { name: 'API-ключ', ok: false, message: 'TestPay не знает такой ключ — создай его в кабинете и вставь заново' }];
    if (key) {
      if (!c.webhookSecret) checks.push({ name: 'Секрет подписи', ok: false, message: 'Не введён — без него вебхуки будут отклоняться (шаг «Вебхук»)' });
      else if (!key.endpoint) checks.push({ name: 'Секрет подписи', ok: false, message: 'В кабинете TestPay у этого ключа ещё нет вебхука' });
      else checks.push(key.endpoint.secret === c.webhookSecret
        ? { name: 'Секрет подписи', ok: true, message: 'Совпадает с кабинетом' }
        : { name: 'Секрет подписи', ok: false, message: 'Не совпадает с кабинетом — секрет перевыпускали? Скопируй заново' });
    }
    return checks;
  }

  async createPayment(creds: AccountCredentials, req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const c = parseCreds(creds.secret);
    if (!this.sim.keys.has(c.apiKey)) throw new Error('TestPay: 401 неверный API-ключ');
    const p = this.sim.create(c.apiKey, req);
    return { kind: 'redirect', providerRef: p.id, redirectUrl: `${this.sim.publicBaseUrl}/testpay/pay/${p.id}` };
  }

  async getPayment(_creds: AccountCredentials, providerRef: string): Promise<ProviderPayment> {
    const p = this.sim.payments.get(providerRef);
    if (!p) throw new Error(`TestPay: платёж ${providerRef} не найден`);
    const paid = p.status === 'success';
    return { status: p.status, amount: paid ? p.amount : null, currency: paid ? p.currency : null, operationId: paid ? `${p.id}_charge` : null };
  }

  readonly paymentTtlSec = 1800;

  async findPayment(_creds: AccountCredentials, reference: string): Promise<{ providerRef: string } | null> {
    for (const p of this.sim.payments.values()) if (p.reference === reference) return { providerRef: p.id };
    return null;
  }

  async refund(_creds: AccountCredentials, req: RefundRequest): Promise<RefundResult> {
    const p = this.sim.payments.get(req.providerRef);
    if (!p || p.status !== 'success') return { kind: 'declined', reason: 'payment_not_found' };
    if (p.refunded + req.amount > p.amount) return { kind: 'declined', reason: 'amount_exceeds_payment' };
    p.refunded += req.amount;
    return { kind: 'success', refundRef: `tp_re_${randomUUID().slice(0, 8)}` };
  }

  verifyWebhook(creds: AccountCredentials, headers: Record<string, string | string[] | undefined>, rawBody: string): VerifiedWebhook {
    const c = parseCreds(creds.secret);
    if (!c.webhookSecret) throw new InvalidWebhookError('Секрет подписи не введён в борде — вставь whsec_… из кабинета провайдера');
    const header = String(headers[TESTPAY_SIGNATURE_HEADER] ?? '');
    const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
    if (!m) throw new InvalidWebhookError('Нет подписи testpay-signature');
    if (Math.abs(Date.now() / 1000 - Number(m[1])) > TOLERANCE_SEC) throw new InvalidWebhookError('Подпись устарела (часы расходятся или повтор старого вебхука)');
    const want = createHmac('sha256', c.webhookSecret).update(`${m[1]}.${rawBody}`).digest();
    const got = Buffer.from(m[2]!, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new InvalidWebhookError('Подпись не сходится — секрет в борде не совпадает с кабинетом провайдера');
    }
    let ev: { id?: unknown; type?: unknown; data?: { payment_id?: unknown } };
    try { ev = JSON.parse(rawBody); } catch { throw new InvalidWebhookError('Тело не JSON'); }
    if (typeof ev.id !== 'string') throw new InvalidWebhookError('Нет id события');
    if (ev.type === 'test') return { eventId: ev.id, providerRef: '', test: true };
    if (typeof ev.data?.payment_id !== 'string') throw new InvalidWebhookError('Нет data.payment_id');
    return { eventId: ev.id, providerRef: ev.data.payment_id };
  }
}
