import type { Pool } from '../db/pool.js';
import type { Client } from '../db/tx.js';
import { decrypt, hmacHex } from '../crypto.js';
import type { TransactionView } from '../routing/router.js';

/*
 * Исходящие вебхуки сайтам (паттерн outbox).
 *  1. Событие записывается в webhook_deliveries в той же транзакции, что и смена статуса платежа —
 *     поэтому оно не потеряется, даже если процесс упадёт сразу после коммита.
 *  2. Воркер забирает готовые к отправке, подписывает HMAC и отправляет; при ошибке — повтор с растущей паузой.
 * Доставка «как минимум один раз»: сайт должен быть готов к повторам (по id события).
 */

export type SiteEvent = 'deposit.succeeded' | 'deposit.declined' | 'deposit.payment_url_changed'
  | 'payout.succeeded' | 'payout.declined' | 'payout.requires_manual'
  | 'deposit.chargeback_opened' | 'deposit.chargeback_won' | 'deposit.chargeback_lost';

export const SIGNATURE_HEADER = 'ftech-signature';
export const MAX_DELIVERY_ATTEMPTS = 12;

export async function enqueueSiteEvent(c: Client, tx: TransactionView, event: SiteEvent, extra?: Record<string, unknown>): Promise<void> {
  // Вебхук ставится в очередь, только если у сайта настроен адрес.
  await c.query(
    `INSERT INTO webhook_deliveries (site_id, transaction_id, event, payload)
     SELECT s.id, $2, $3::text, jsonb_build_object('event', $3::text, 'data', $4::jsonb)
     FROM sites s WHERE s.id = $1 AND s.webhook_url IS NOT NULL`,
    [tx.siteId, tx.id, event, JSON.stringify({
      id: tx.id, type: tx.type, status: tx.status, amount: tx.amount.toString(), currency: tx.currency,
      declineCode: tx.declineCode, paymentUrl: tx.status === 'pending' ? tx.paymentUrl : null,
      updatedAt: tx.updatedAt.toISOString(), ...(extra ?? {}),
    })],
  );
}

/** Заголовок подписи: t=<unix-время>,v1=<hex HMAC-SHA256 от "t.тело"> секретом сайта. */
export function signSitePayload(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${hmacHex(secret, `${ts}.${body}`)}`;
}

export function backoffSeconds(attempt: number): number {
  return Math.min(10 * 2 ** (attempt - 1), 6 * 3600); // 10с, 20с, 40с … до 6 часов
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number }>;

export interface DispatchDeps {
  pool: Pool;
  encryptionKey: Buffer;
  fetch?: Fetcher;
  batchSize?: number;
  timeoutMs?: number;
}

/** Один проход воркера. Возвращает, сколько вебхуков доставлено и сколько не удалось. */
export async function dispatchOnce(d: DispatchDeps): Promise<{ delivered: number; failed: number }> {
  const doFetch = d.fetch ?? (globalThis.fetch as unknown as Fetcher);
  // Забираем пачку и сразу «арендуем» её на 2 минуты: другой воркер её не возьмёт,
  // а если этот упадёт посреди отправки — после аренды события вернутся в очередь.
  const jobs = (await d.pool.query(
    `UPDATE webhook_deliveries w SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
     FROM sites s
     WHERE w.site_id = s.id AND w.id IN (
       SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING w.id, w.payload, w.attempts, s.webhook_url, s.webhook_secret_enc`,
    [d.batchSize ?? 20],
  )).rows;

  let delivered = 0, failed = 0;
  for (const j of jobs) {
    let error: string | null = null;
    try {
      if (!j.webhook_url || !j.webhook_secret_enc) throw new Error('У сайта не настроен адрес или секрет вебхука');
      const body = JSON.stringify({ id: `evt_${j.id}`, ...j.payload });
      const secret = decrypt(d.encryptionKey, j.webhook_secret_enc);
      const res = await doFetch(j.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signSitePayload(secret, body) },
        body,
        signal: AbortSignal.timeout(d.timeoutMs ?? 10_000),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }

    if (!error) {
      delivered++;
      await d.pool.query(`UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1`, [j.id]);
    } else {
      failed++;
      const giveUp = j.attempts >= MAX_DELIVERY_ATTEMPTS;
      await d.pool.query(
        `UPDATE webhook_deliveries SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [j.id, giveUp ? 'failed' : 'pending', error, backoffSeconds(j.attempts)],
      );
    }
  }
  return { delivered, failed };
}
