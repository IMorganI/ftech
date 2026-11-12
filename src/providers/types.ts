/**
 * Единый интерфейс платёжного провайдера. Каждая платёжка — отдельный адаптер с этим интерфейсом;
 * остальная система про конкретных провайдеров ничего не знает.
 *
 * Правило безопасности: номера карт к нам не попадают никогда. Игрок вводит карту на странице
 * провайдера (redirectUrl), к нам приходят только ID платежа и статус.
 */

export interface AccountCredentials {
  accountId: string;
  secret: string;
}

export interface CreatePaymentRequest {
  /** Наш ID попытки — провайдер вернёт его в вебхуке и отчётах. */
  reference: string;
  amount: bigint;
  currency: string;
  country: string;
  returnUrl: string | null;
}

export type CreatePaymentResult =
  | { kind: 'redirect'; providerRef: string; redirectUrl: string }
  | { kind: 'declined'; providerRef?: string; reason: string };

export type ProviderStatus = 'pending' | 'success' | 'declined';

export interface RefundRequest {
  /** Наш ID платежа у провайдера (тот, что вернул createPayment). */
  providerRef: string;
  amount: bigint;
  currency: string;
  /** Наш ID части выплаты — для отчётов провайдера. */
  reference: string;
}

/** Возврат на карту: success — деньги ушли, declined — провайдер явно отказал (тогда часть станет ручной).
 *  Сетевая ошибка — исключение: неизвестно, прошёл ли возврат, это разбирает человек. */
export type RefundResult = { kind: 'success'; refundRef?: string } | { kind: 'declined'; reason: string };

export interface VerifiedWebhook {
  eventId: string;
  providerRef: string;
}

export class InvalidWebhookError extends Error {}

export interface ProviderAdapter {
  readonly name: string;
  createPayment(creds: AccountCredentials, req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  /** Статус у провайдера. Используется и после вебхука: содержимому вебхука на слово не верим. */
  getStatus(creds: AccountCredentials, providerRef: string): Promise<ProviderStatus>;
  /** Проверяет подлинность входящего вебхука (подпись или секретный токен в адресе) и достаёт из него ID.
   *  Не прошёл проверку — InvalidWebhookError. */
  verifyWebhook(creds: AccountCredentials, headers: Record<string, string | string[] | undefined>, rawBody: string,
    query?: Record<string, unknown>): VerifiedWebhook;
  /** Возврат (полный или частичный) по успешной оплате — основа выплат по closed loop. */
  refund?(creds: AccountCredentials, req: RefundRequest): Promise<RefundResult>;
  /** Сколько фактически оплачено (в минорных единицах), если провайдер это сообщает. null — неизвестно. */
  paidAmount?(creds: AccountCredentials, providerRef: string): Promise<bigint | null>;
  /** Если провайдер проверяет адрес вебхука GET-запросом (как Viva) — что ему ответить. */
  webhookChallenge?(creds: AccountCredentials, query: Record<string, unknown>): Promise<unknown>;
}

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  register(a: ProviderAdapter): this {
    this.adapters.set(a.name, a);
    return this;
  }
  get(name: string): ProviderAdapter {
    const a = this.adapters.get(name);
    if (!a) throw new Error(`Адаптер провайдера «${name}» не подключён`);
    return a;
  }
}
