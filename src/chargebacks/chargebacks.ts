import type { Pool } from '../db/pool.js';
import { withTransaction, type Client } from '../db/tx.js';
import { audit } from '../admin/auth.js';
import { enqueueSiteEvent } from '../webhooks/outbox.js';
import { getTransactionById } from '../routing/router.js';

/*
 * Чарджбэки.
 *
 * Жизненный цикл: open → (evidence_submitted) → won | lost; либо open → accepted (решили не оспаривать).
 * При открытии эквайер обычно сразу списывает сумму с мерчанта — так и записываем:
 *   merchant:<аккаунт> −сумма, chargeback_hold:<оператор> +сумма; комиссия — merchant − / provider_fees +.
 *   Выиграли   — сумма возвращается: merchant +, chargeback_hold −.
 *   Проиграли/приняли — потеря: chargeback_hold −, chargeback_loss:<оператор> +.
 * Оспоренная часть депозита не может быть возвращена игроку выплатой (charged_back_amount).
 * Сайт получает вебхук deposit.chargeback_opened / _won / _lost — например, чтобы заморозить баланс игрока.
 */

export type ChargebackStatus = 'open' | 'evidence_submitted' | 'won' | 'lost' | 'accepted';
export const FINAL: ChargebackStatus[] = ['won', 'lost', 'accepted'];

export class ChargebackError extends Error {
  constructor(readonly code: 'not_found' | 'not_deposit' | 'too_much' | 'bad_transition' | 'duplicate', message: string) { super(message); }
}

export interface OpenChargeback {
  transactionId: string;
  amount?: bigint;          // по умолчанию — вся неоспоренная и невозвращённая часть
  fee?: bigint;
  caseRef?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  respondBy?: string | null; // YYYY-MM-DD
  source: 'manual' | 'report';
  note?: string | null;
}

interface Ctx { userId?: string | null; ip?: string }

async function ledger(c: Client, txId: string, cur: string, rows: [string, bigint][]) {
  for (const [account, amount] of rows) {
    await c.query(`INSERT INTO ledger_entries (transaction_id, account, amount, currency) VALUES ($1, $2, $3, $4)`, [txId, account, amount, cur]);
  }
}

export async function openChargeback(pool: Pool, input: OpenChargeback, ctx: Ctx = {}): Promise<{ id: string; created: boolean }> {
  return withTransaction(pool, async (c) => {
    const tx = (await c.query(
      `SELECT t.id, t.type, t.status, t.amount, t.currency, t.refunded_amount, t.charged_back_amount, t.merchant_account_id,
              s.operator_id FROM transactions t JOIN sites s ON s.id = t.site_id WHERE t.id = $1 FOR UPDATE OF t`, [input.transactionId])).rows[0];
    if (!tx) throw new ChargebackError('not_found', 'Платёж не найден');
    if (tx.type !== 'deposit' || tx.status !== 'success' || !tx.merchant_account_id) {
      throw new ChargebackError('not_deposit', 'Чарджбэк бывает только по успешному депозиту');
    }
    if (input.caseRef) {
      const dup = (await c.query(`SELECT id FROM chargebacks WHERE merchant_account_id = $1 AND case_ref = $2`,
        [tx.merchant_account_id, input.caseRef])).rows[0];
      if (dup) return { id: dup.id as string, created: false };
    }
    const free = BigInt(tx.amount) - BigInt(tx.refunded_amount) - BigInt(tx.charged_back_amount);
    const amount = input.amount ?? free;
    if (amount <= 0n || amount > free) {
      throw new ChargebackError('too_much', `Можно оспорить не больше ${free} (сумма депозита минус уже возвращённое и уже оспоренное)`);
    }
    const fee = input.fee ?? 0n;
    const cur = (tx.currency as string).trim();
    const id = (await c.query(
      `INSERT INTO chargebacks (transaction_id, merchant_account_id, case_ref, reason_code, reason, amount, currency, fee, respond_by, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [tx.id, tx.merchant_account_id, input.caseRef ?? null, input.reasonCode ?? null, input.reason ?? null, amount, cur, fee,
       input.respondBy ?? null, input.source, ctx.userId ?? null])).rows[0].id as string;
    await c.query(`UPDATE transactions SET charged_back_amount = charged_back_amount + $2, updated_at = now() WHERE id = $1`, [tx.id, amount]);
    await c.query(`INSERT INTO chargeback_events (chargeback_id, status, note, admin_user_id) VALUES ($1, 'open', $2, $3)`,
      [id, input.note ?? (input.source === 'report' ? 'найден в выписке провайдера' : null), ctx.userId ?? null]);
    const acc = `merchant:${tx.merchant_account_id}`;
    await ledger(c, tx.id, cur, [[acc, -amount], [`chargeback_hold:${tx.operator_id}`, amount],
      ...(fee > 0n ? [[acc, -fee], [`provider_fees:${tx.merchant_account_id}`, fee]] as [string, bigint][] : [])]);
    await enqueueSiteEvent(c, (await getTransactionById(c, tx.id))!, 'deposit.chargeback_opened',
      { chargeback: { id, amount: amount.toString(), status: 'open', reasonCode: input.reasonCode ?? null } });
    if (ctx.userId) {
      await audit(c, { userId: ctx.userId, action: 'chargeback.open', entity: 'chargeback', entityId: id, ip: ctx.ip,
        after: { transactionId: tx.id, amount, fee, caseRef: input.caseRef ?? null } });
    }
    return { id, created: true };
  });
}

const ALLOWED: Record<ChargebackStatus, ChargebackStatus[]> = {
  open: ['evidence_submitted', 'won', 'lost', 'accepted'],
  evidence_submitted: ['won', 'lost'],
  won: [], lost: [], accepted: [],
};

export async function updateChargeback(pool: Pool, id: string, status: ChargebackStatus, ctx: Ctx, note?: string | null): Promise<void> {
  await withTransaction(pool, async (c) => {
    const cb = (await c.query(
      `SELECT cb.*, s.operator_id FROM chargebacks cb JOIN transactions t ON t.id = cb.transaction_id JOIN sites s ON s.id = t.site_id
       WHERE cb.id = $1 FOR UPDATE OF cb`, [id])).rows[0];
    if (!cb) throw new ChargebackError('not_found', 'Чарджбэк не найден');
    if (!ALLOWED[cb.status as ChargebackStatus].includes(status)) {
      throw new ChargebackError('bad_transition', `Из статуса «${cb.status}» нельзя перейти в «${status}»`);
    }
    const final = FINAL.includes(status);
    await c.query(`UPDATE chargebacks SET status = $2, resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END WHERE id = $1`, [id, status, final]);
    await c.query(`INSERT INTO chargeback_events (chargeback_id, status, note, admin_user_id) VALUES ($1, $2, $3, $4)`, [id, status, note ?? null, ctx.userId ?? null]);
    const amount = BigInt(cb.amount); const cur = (cb.currency as string).trim();
    const hold = `chargeback_hold:${cb.operator_id}`;
    if (status === 'won') {
      // Спор выигран: эквайер вернул сумму; часть депозита снова можно вернуть игроку.
      await ledger(c, cb.transaction_id, cur, [[`merchant:${cb.merchant_account_id}`, amount], [hold, -amount]]);
      await c.query(`UPDATE transactions SET charged_back_amount = charged_back_amount - $2, updated_at = now() WHERE id = $1`, [cb.transaction_id, amount]);
    } else if (status === 'lost' || status === 'accepted') {
      await ledger(c, cb.transaction_id, cur, [[hold, -amount], [`chargeback_loss:${cb.operator_id}`, amount]]);
    }
    if (final) {
      await enqueueSiteEvent(c, (await getTransactionById(c, cb.transaction_id))!, status === 'won' ? 'deposit.chargeback_won' : 'deposit.chargeback_lost',
        { chargeback: { id, amount: amount.toString(), status } });
    }
    if (ctx.userId) {
      await audit(c, { userId: ctx.userId, action: `chargeback.${status}`, entity: 'chargeback', entityId: id, ip: ctx.ip, after: { note: note ?? null } });
    }
  });
}
