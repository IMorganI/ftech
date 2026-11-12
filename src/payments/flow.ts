import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import type { SecretStore } from '../secrets.js';
import { InvalidWebhookError, type ProviderRegistry, type AccountCredentials, type ProviderAdapter } from '../providers/types.js';
import { resolveAttempt, getTransactionById, type TransactionView } from '../routing/router.js';
import { enqueueSiteEvent } from '../webhooks/outbox.js';
import { accountCredentials } from '../providers/credentials.js';

/*
 * Связь роутера с провайдерами.
 *
 * Важно: запрос к провайдеру (1–3 секунды) никогда не выполняется внутри транзакции базы,
 * иначе блокировки лимитов держались бы всё это время. Порядок всегда такой:
 *   резерв в базе → коммит → запрос к провайдеру → результат отдельной короткой транзакцией.
 */

export interface PaymentDeps {
  pool: Pool;
  providers: ProviderRegistry;
  secrets: SecretStore;
  /** Для ключей провайдеров, введённых в борде (зашифрованы в базе). */
  encryptionKey?: Buffer;
}

interface AttemptRow {
  id: string;
  transaction_id: string;
  attempt_no: number;
  status: string;
  provider_ref: string | null;
  merchant_account_id: string;
  credentials_ref: string | null;
  adapter: string;
  amount: bigint;
  currency: string;
  country: string;
  return_url: string | null;
}

const ATTEMPT_SELECT = `
  SELECT a.id, a.transaction_id, a.attempt_no, a.status, a.provider_ref, a.merchant_account_id,
         m.credentials_ref, p.adapter, t.amount, t.currency, pl.country, t.return_url
  FROM transaction_attempts a
  JOIN merchant_accounts m ON m.id = a.merchant_account_id
  JOIN providers p ON p.id = m.provider_id
  JOIN transactions t ON t.id = a.transaction_id
  JOIN players pl ON pl.id = t.player_id`;

async function credsFor(d: PaymentDeps, accountId: string, _ref?: string | null): Promise<AccountCredentials> {
  return accountCredentials(d, accountId);
}

/**
 * Отправляет текущую попытку платежа провайдеру. При мгновенном отказе — каскад на следующий
 * аккаунт и новая отправка, пока платёж не получит ссылку на оплату или окончательный отказ.
 */
export async function submitPending(d: PaymentDeps, txId: string): Promise<TransactionView> {
  for (let guard = 0; guard < 10; guard++) {
    // Захватываем попытку: отправить её может только один процесс.
    const claimed = (await d.pool.query<AttemptRow>(
      `WITH c AS (UPDATE transaction_attempts SET submitted_at = now()
                  WHERE transaction_id = $1 AND status = 'pending' AND submitted_at IS NULL RETURNING id)
       ${ATTEMPT_SELECT} WHERE a.id IN (SELECT id FROM c)`, [txId],
    )).rows[0];
    if (!claimed) break;

    let adapter: ProviderAdapter;
    let result;
    try {
      adapter = d.providers.get(claimed.adapter);
      result = await adapter.createPayment(await credsFor(d, claimed.merchant_account_id, claimed.credentials_ref), {
        reference: claimed.id, amount: claimed.amount, currency: claimed.currency.trim(),
        country: claimed.country.trim(), returnUrl: claimed.return_url,
      });
    } catch (err) {
      // Не знаем, создался ли платёж у провайдера, поэтому не каскадим вслепую:
      // попытка остаётся pending, её разберёт сверка (reconcile).
      await d.pool.query(`UPDATE transaction_attempts SET error = $2 WHERE id = $1`,
        [claimed.id, `submit_error: ${(err as Error).message}`.slice(0, 500)]);
      break;
    }

    if (result.kind === 'redirect') {
      await withTransaction(d.pool, async (c) => {
        await c.query(`UPDATE transaction_attempts SET provider_ref = $2, redirect_url = $3 WHERE id = $1`,
          [claimed.id, result.providerRef, result.redirectUrl]);
        // После каскада у платежа новая ссылка на оплату — сообщаем сайту.
        if (claimed.attempt_no > 1) {
          const tx = await getTransactionById(c, txId);
          if (tx) await enqueueSiteEvent(c, tx, 'deposit.payment_url_changed');
        }
      });
      break;
    }

    // Мгновенный отказ провайдера → каскад (resolveAttempt сам выберет следующий аккаунт).
    const after = await resolveAttempt(d.pool, txId, {
      status: 'declined', attemptId: claimed.id, providerRef: result.providerRef, error: result.reason,
    });
    if (after.status !== 'pending') break;
  }
  const tx = await getTransactionById(d.pool, txId);
  if (!tx) throw new Error(`Платёж ${txId} не найден`);
  return tx;
}

/** GET-проверка адреса вебхука провайдером (Viva при настройке). Нет такой у адаптера — null. */
export async function providerWebhookChallenge(d: PaymentDeps, accountId: string, query: Record<string, unknown>): Promise<unknown | null> {
  const acc = (await d.pool.query(
    `SELECT m.id, m.credentials_ref, p.adapter FROM merchant_accounts m JOIN providers p ON p.id = m.provider_id WHERE m.id = $1`,
    [accountId])).rows[0];
  if (!acc) throw new InvalidWebhookError('Аккаунт не найден');
  const adapter = d.providers.get(acc.adapter);
  if (!adapter.webhookChallenge) return null;
  return adapter.webhookChallenge(await credsFor(d, acc.id, acc.credentials_ref), query);
}

const formatCents = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

export type WebhookResult = 'processed' | 'duplicate' | 'unknown_payment' | 'still_pending' | 'issue_recorded';

/**
 * Входящий вебхук провайдера. Подпись проверяет адаптер; статус берём не из тела вебхука,
 * а запросом к провайдеру — поддельный «оплачено» без реальной оплаты ничего не даст.
 */
export async function handleProviderWebhook(
  d: PaymentDeps, accountId: string, headers: Record<string, string | string[] | undefined>, rawBody: string,
  query: Record<string, unknown> = {},
): Promise<WebhookResult> {
  const acc = (await d.pool.query(
    `SELECT m.id, m.credentials_ref, p.adapter FROM merchant_accounts m JOIN providers p ON p.id = m.provider_id WHERE m.id = $1`,
    [accountId],
  )).rows[0];
  if (!acc) throw new InvalidWebhookError('Аккаунт не найден');
  const adapter = d.providers.get(acc.adapter);
  const creds = await credsFor(d, acc.id, acc.credentials_ref);
  const hook = adapter.verifyWebhook(creds, headers, rawBody, query); // бросит InvalidWebhookError

  const fresh = (await d.pool.query(
    `INSERT INTO provider_webhook_events (merchant_account_id, event_id, provider_ref, body)
     VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_account_id, event_id) DO NOTHING RETURNING id`,
    [acc.id, hook.eventId, hook.providerRef, rawBody],
  )).rows[0];
  if (!fresh) return 'duplicate';

  const result = await applyProviderStatus(d, adapter, creds, acc.id, hook.providerRef);
  await d.pool.query(`UPDATE provider_webhook_events SET result = $2 WHERE id = $1`, [fresh.id, result]);
  return result;
}

async function applyProviderStatus(
  d: PaymentDeps, adapter: ProviderAdapter, creds: AccountCredentials, accountId: string, providerRef: string,
): Promise<WebhookResult> {
  const attempt = (await d.pool.query<AttemptRow>(
    `${ATTEMPT_SELECT} WHERE a.merchant_account_id = $1 AND a.provider_ref = $2`, [accountId, providerRef],
  )).rows[0];
  if (!attempt) return 'unknown_payment';

  const status = await adapter.getStatus(creds, providerRef);
  if (status === 'pending') return 'still_pending';

  if (attempt.status === 'pending' && status === 'success' && adapter.paidAmount) {
    // Сверка суммы: зачисляем, только если оплачено ровно столько, сколько мы просили.
    const paid = await adapter.paidAmount(creds, providerRef);
    if (paid !== null && paid !== attempt.amount) {
      await d.pool.query(`UPDATE transaction_attempts SET error = $2 WHERE id = $1`,
        [attempt.id, `amount_mismatch: ожидали ${attempt.amount}, оплачено ${paid}`]);
      await d.pool.query(
        `INSERT INTO reconciliation_issues (transaction_id, attempt_id, kind, details)
         SELECT $1, $2, 'amount_mismatch', $3
         WHERE NOT EXISTS (SELECT 1 FROM reconciliation_issues WHERE attempt_id = $2 AND kind = 'amount_mismatch')`,
        [attempt.transaction_id, attempt.id,
         `Ожидали ${formatCents(attempt.amount)} ${attempt.currency.trim()}, у провайдера оплачено ${formatCents(paid)} (ref ${providerRef}). Платёж не зачислен.`]);
      return 'issue_recorded';
    }
  }

  if (attempt.status === 'pending') {
    const tx = await resolveAttempt(d.pool, attempt.transaction_id, { status, attemptId: attempt.id, providerRef });
    if (tx.status === 'pending') await submitPending(d, tx.id); // каскад: отправляем следующую попытку
    return 'processed';
  }
  if (attempt.status !== status) {
    // Провайдер говорит одно, у нас записано другое. Самое опасное — оплата по попытке,
    // которую мы уже закрыли отказом: деньги пришли, а платёж ушёл дальше. Это разбирает человек.
    await d.pool.query(
      `INSERT INTO reconciliation_issues (transaction_id, attempt_id, kind, details) VALUES ($1, $2, $3, $4)`,
      [attempt.transaction_id, attempt.id, status === 'success' ? 'late_success' : 'status_mismatch',
       `У нас ${attempt.status}, у провайдера ${status} (ref ${providerRef})`],
    );
    return 'issue_recorded';
  }
  return 'processed';
}

/**
 * Сверка зависших попыток: вебхук мог потеряться. Спрашиваем статус у провайдера сами.
 * Попытки, которые не удалось даже отправить, закрываются отказом (с каскадом).
 */
export async function reconcilePending(d: PaymentDeps, olderThanSec = 300): Promise<{ checked: number; resolved: number }> {
  const rows = (await d.pool.query<AttemptRow & { error: string | null; submitted_at: Date | null }>(
    `${ATTEMPT_SELECT.replace('SELECT a.id,', 'SELECT a.error, a.submitted_at, a.id,')}
     WHERE a.status = 'pending' AND coalesce(a.submitted_at, a.created_at) < now() - make_interval(secs => $1)
       AND (a.error IS NULL OR a.error NOT LIKE 'amount_mismatch%') -- такие разбирает человек
     ORDER BY a.created_at LIMIT 100`, [olderThanSec],
  )).rows;
  let resolved = 0;
  for (const a of rows) {
    try {
      if (!a.submitted_at) {
        // Процесс упал между резервом и отправкой — отправляем сейчас.
        await submitPending(d, a.transaction_id);
        resolved++;
        continue;
      }
      if (!a.provider_ref) {
        const tx = await resolveAttempt(d.pool, a.transaction_id, { status: 'declined', attemptId: a.id, error: a.error ?? 'not_submitted' });
        if (tx.status === 'pending') await submitPending(d, tx.id);
        resolved++;
        continue;
      }
      const adapter = d.providers.get(a.adapter);
      const r = await applyProviderStatus(d, adapter, await credsFor(d, a.merchant_account_id, a.credentials_ref), a.merchant_account_id, a.provider_ref);
      if (r === 'processed') resolved++;
    } catch {
      // Провайдер недоступен — попробуем на следующем проходе.
    }
  }
  return { checked: rows.length, resolved };
}
