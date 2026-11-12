import { applyRestrictions, lockPlayer } from '../players/restrictions.js';
import { createHash } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { withTransaction, isUniqueViolation, type Client } from '../db/tx.js';
import type { PaymentDeps } from '../payments/flow.js';
import { enqueueSiteEvent } from '../webhooks/outbox.js';
import { accountCredentials } from '../providers/credentials.js';
import { getTransactionById, IdempotencyConflictError, type TransactionView } from '../routing/router.js';
import { audit } from '../admin/auth.js';

/*
 * Выплаты игрокам по принципу closed loop.
 *
 * 1. Проверки: игрок известен сайту, KYC (если оператор требует), валюта.
 * 2. Раскладка суммы по успешным депозитам игрока в этой валюте (от новых к старым):
 *    каждая часть — возврат на ту же карту, не больше ещё не возвращённого остатка депозита.
 *    Остаток резервируется сразу (refunded_amount), поэтому параллельные выплаты не вернут один депозит дважды.
 * 3. Что не покрывается возвратами — ручная выплата: оператор переводит сам и отмечает в борде.
 * 4. Возвраты исполняются у провайдера вне транзакции базы. Явный отказ провайдера — резерв снимается,
 *    часть превращается в ручную. Ошибка связи — неизвестно, прошёл ли возврат: часть ждёт, создаётся
 *    проблема для ручной проверки (повторно не отправляем, чтобы не вернуть дважды).
 * 5. Выплата успешна, когда все её части выполнены. Сайт получает вебхук payout.*.
 *
 * Проводки: возврат/выплата — merchant:<аккаунт> или manual:<оператор> (−), player:<игрок> (+).
 */

export interface PayoutRequest {
  siteId: string;
  operatorId: string;
  idempotencyKey: string;
  amount: bigint;
  currency: string;
  /** ID вывода в системе казино: один вывод — одна выплата. */
  withdrawalId: string;
  player: { externalId: string; kyc?: 'none' | 'pending' | 'verified' | 'rejected' };
}

export type PayoutDecline = 'kyc_required' | 'amount_over_limit';

/** Этот вывод казино уже выплачивается (пришёл повторно с другим Idempotency-Key). */
export class DuplicateWithdrawalError extends Error {
  constructor(readonly payoutId: string) { super('Выплата по этому withdrawalId уже создана'); }
}

/** Ошибки действий с ручной выплатой в борде (с понятным кодом). */
export class ManualLegError extends Error {
  constructor(readonly code: 'not_found' | 'approval_required' | 'same_person' | 'already_approved' | 'approval_not_needed', message: string) { super(message); }
}

/** Игрок не известен сайту — выплачивать некому (он ни разу не делал депозит через нас). */
export class UnknownPlayerError extends Error {
  constructor() { super('Игрок не найден: у него нет депозитов через этот сайт'); }
}

export interface PayoutLegView {
  id: string;
  kind: 'refund' | 'manual';
  amount: bigint;
  status: 'pending' | 'success' | 'failed';
}

function hash(r: PayoutRequest) {
  return createHash('sha256').update(JSON.stringify(['payout', r.amount.toString(), r.currency, r.player.externalId, r.withdrawalId])).digest('hex');
}

export async function createPayout(pool: Pool, req: PayoutRequest): Promise<{ tx: TransactionView; replayed: boolean }> {
  const h = hash(req);
  const lookup = async (c: Client | Pool) => (await c.query(
    `SELECT id, request_hash FROM transactions WHERE site_id = $1 AND idempotency_key = $2`, [req.siteId, req.idempotencyKey])).rows[0];
  const replay = async (row: { id: string; request_hash: string }) => {
    if (row.request_hash !== h) throw new IdempotencyConflictError();
    return { tx: (await getTransactionById(pool, row.id))!, replayed: true };
  };
  try {
    const result = await withTransaction(pool, async (c) => {
      const existing = await lookup(c);
      if (existing) return { existing };
      const dup = (await c.query(`SELECT id FROM transactions WHERE site_id = $1 AND withdrawal_id = $2`, [req.siteId, req.withdrawalId])).rows[0];
      if (dup) throw new DuplicateWithdrawalError(dup.id);
      return { id: await insertPayout(c, req, h) };
    });
    if ('existing' in result) return replay(result.existing);
    return { tx: (await getTransactionById(pool, result.id))!, replayed: false };
  } catch (err) {
    if (isUniqueViolation(err, 'transactions_site_id_idempotency_key_key')) {
      const row = await lookup(pool);
      if (row) return replay(row);
    }
    if (isUniqueViolation(err, 'transactions_withdrawal_idx')) {
      const dup = (await pool.query(`SELECT id FROM transactions WHERE site_id = $1 AND withdrawal_id = $2`, [req.siteId, req.withdrawalId])).rows[0];
      throw new DuplicateWithdrawalError(dup?.id);
    }
    throw err;
  }
}

async function insertPayout(c: Client, req: PayoutRequest, h: string): Promise<string> {
  // Игрок блокируется: выплаты одного игрока идут по очереди.
  const player = (await c.query(
    `SELECT id, kyc FROM players WHERE site_id = $1 AND external_id = $2 FOR UPDATE`, [req.siteId, req.player.externalId])).rows[0];
  const op = (await c.query(`SELECT payout_kyc_required, payout_max_amount FROM operators WHERE id = $1`, [req.operatorId])).rows[0];

  const insert = async (playerId: string, status: 'pending' | 'declined', decline: PayoutDecline | null) =>
    (await c.query(
      `INSERT INTO transactions (site_id, player_id, type, amount, currency, status, decline_code, idempotency_key, request_hash, withdrawal_id)
       VALUES ($1, $2, 'payout', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.siteId, playerId, req.amount, req.currency, status, decline, req.idempotencyKey, h, req.withdrawalId])).rows[0].id as string;

  if (!player) throw new UnknownPlayerError();
  if (req.player.kyc && req.player.kyc !== player.kyc) {
    // Через общий модуль ограничений: изменение KYC попадает в журнал игрока.
    const updated = await applyRestrictions(c, await lockPlayer(c, player.id), { kyc: req.player.kyc }, 'payout', { increaseDelayHours: 24 });
    player.kyc = updated.kyc;
  }
  if (op.payout_kyc_required && player.kyc !== 'verified') return insert(player.id, 'declined', 'kyc_required');
  if (op.payout_max_amount !== null && req.amount > op.payout_max_amount) return insert(player.id, 'declined', 'amount_over_limit');

  const payoutId = await insert(player.id, 'pending', null);

  // Раскладка по депозитам: от новых к старым (у новых больше шансов, что провайдер ещё разрешает возврат).
  const deposits = (await c.query(
    `SELECT t.id, t.amount - t.refunded_amount AS available, t.merchant_account_id
     FROM transactions t
     WHERE t.player_id = $1 AND t.type = 'deposit' AND t.status = 'success' AND t.currency = $2 AND t.refunded_amount < t.amount
     ORDER BY t.created_at DESC FOR UPDATE`, [player.id, req.currency])).rows;

  let remaining = req.amount;
  for (const d of deposits) {
    if (remaining === 0n) break;
    const take = (d.available as bigint) < remaining ? (d.available as bigint) : remaining;
    await c.query(`UPDATE transactions SET refunded_amount = refunded_amount + $2 WHERE id = $1`, [d.id, take]);
    await c.query(
      `INSERT INTO payout_legs (payout_id, kind, deposit_id, merchant_account_id, amount) VALUES ($1, 'refund', $2, $3, $4)`,
      [payoutId, d.id, d.merchant_account_id, take]);
    remaining -= take;
  }
  if (remaining > 0n) {
    await c.query(`INSERT INTO payout_legs (payout_id, kind, amount) VALUES ($1, 'manual', $2)`, [payoutId, remaining]);
  }
  return payoutId;
}

/** Исполнить ожидающие возвраты выплаты у провайдеров и подвести итог. */
export async function executePayout(d: PaymentDeps, payoutId: string): Promise<TransactionView> {
  for (;;) {
    // Захват части: отправить возврат может только один процесс.
    const leg = (await d.pool.query(
      `UPDATE payout_legs l SET submitted_at = now()
       FROM transactions dep, transaction_attempts a, merchant_accounts m, providers p
       WHERE l.id = (SELECT id FROM payout_legs WHERE payout_id = $1 AND kind = 'refund' AND status = 'pending'
                     AND submitted_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         AND dep.id = l.deposit_id AND a.transaction_id = dep.id AND a.status = 'success'
         AND m.id = l.merchant_account_id AND p.id = m.provider_id
       RETURNING l.id, l.amount, l.deposit_id, a.provider_ref, dep.currency, m.id AS account_id, m.credentials_ref, p.adapter`,
      [payoutId])).rows[0];
    if (!leg) break;

    const adapter = (() => { try { return d.providers.get(leg.adapter); } catch { return null; } })();
    if (!adapter?.refund) {
      await toManual(d.pool, leg.id, leg.deposit_id, leg.amount, 'провайдер не поддерживает возвраты через API');
      continue;
    }
    let result;
    try {
      result = await adapter.refund(await accountCredentials(d, leg.account_id),
        { providerRef: leg.provider_ref, amount: leg.amount, currency: leg.currency.trim(), reference: leg.id });
    } catch (err) {
      // Неизвестно, прошёл ли возврат: не повторяем автоматически, отдаём человеку.
      const msg = `refund_error: ${(err as Error).message}`.slice(0, 500);
      await d.pool.query(`UPDATE payout_legs SET error = $2 WHERE id = $1`, [leg.id, msg]);
      await d.pool.query(
        `INSERT INTO reconciliation_issues (transaction_id, kind, details) VALUES ($1, 'refund_unknown', $2)`,
        [payoutId, `Возврат ${leg.amount} по депозиту ${leg.deposit_id}: нет ответа провайдера (${msg}). Проверь в кабинете провайдера, прошёл ли он.`]);
      continue;
    }

    if (result.kind === 'success') {
      await withTransaction(d.pool, async (c) => {
        await c.query(`UPDATE payout_legs SET status = 'success', provider_ref = $2, completed_at = now() WHERE id = $1`,
          [leg.id, result.refundRef ?? null]);
        await ledgerOut(c, payoutId, `merchant:${leg.account_id}`, leg.amount);
      });
    } else {
      await toManual(d.pool, leg.id, leg.deposit_id, leg.amount, `возврат отклонён провайдером: ${result.reason}`);
    }
  }
  return finalize(d.pool, payoutId);
}

/** Возврат не получился — резерв депозита снимается, сумма уходит в ручную выплату. */
async function toManual(pool: Pool, legId: string, depositId: string, amount: bigint, reason: string) {
  await withTransaction(pool, async (c) => {
    const leg = (await c.query(`UPDATE payout_legs SET status = 'failed', error = $2, completed_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING payout_id`, [legId, reason.slice(0, 500)])).rows[0];
    if (!leg) return;
    await c.query(`UPDATE transactions SET refunded_amount = refunded_amount - $2 WHERE id = $1`, [depositId, amount]);
    await c.query(`INSERT INTO payout_legs (payout_id, kind, amount, note) VALUES ($1, 'manual', $2, $3)`,
      [leg.payout_id, amount, `вместо возврата: ${reason}`.slice(0, 500)]);
  });
}

async function ledgerOut(c: Client, payoutId: string, account: string, amount: bigint) {
  await c.query(
    `INSERT INTO ledger_entries (transaction_id, account, amount, currency)
     SELECT t.id, $2, -$3::bigint, t.currency FROM transactions t WHERE t.id = $1
     UNION ALL SELECT t.id, 'player:' || t.player_id, $3::bigint, t.currency FROM transactions t WHERE t.id = $1`,
    [payoutId, account, amount]);
}

/** Оператор отметил ручную выплату выполненной. */
interface ActionCtx { userId: string; ip?: string }

/** Ручная выплата и нужно ли для неё одобрение второго сотрудника. Под блокировкой строки. */
async function lockManualLeg(c: Client, legId: string) {
  const leg = (await c.query(
    `SELECT l.id, l.payout_id, l.amount, l.status, l.approved_by, o.id AS operator_id, o.manual_approval_above
     FROM payout_legs l JOIN transactions t ON t.id = l.payout_id JOIN sites s ON s.id = t.site_id JOIN operators o ON o.id = s.operator_id
     WHERE l.id = $1 AND l.kind = 'manual' FOR UPDATE OF l`, [legId])).rows[0];
  if (!leg || leg.status !== 'pending') throw new ManualLegError('not_found', 'Ожидающая ручная выплата не найдена');
  const needsApproval = leg.manual_approval_above !== null && BigInt(leg.amount) >= BigInt(leg.manual_approval_above);
  return { ...leg, needsApproval };
}

/** Одобрить ручную выплату (первый сотрудник). Выполненной её отметит другой. */
export async function approveManualLeg(pool: Pool, legId: string, ctx: ActionCtx): Promise<void> {
  await withTransaction(pool, async (c) => {
    const leg = await lockManualLeg(c, legId);
    if (!leg.needsApproval) throw new ManualLegError('approval_not_needed', 'Эта сумма не требует одобрения — её можно сразу отметить выполненной');
    if (leg.approved_by) throw new ManualLegError('already_approved', 'Уже одобрено');
    await c.query(`UPDATE payout_legs SET approved_by = $2, approved_at = now() WHERE id = $1`, [legId, ctx.userId]);
    // Журнал — в той же транзакции: действие и запись о нём либо есть обе, либо нет ни одной.
    await audit(c, { userId: ctx.userId, action: 'payout.manual_approve', entity: 'payout', entityId: leg.payout_id, ip: ctx.ip,
      after: { legId, amount: leg.amount } });
  });
}

/**
 * Отметить ручную выплату выполненной: номер подтверждающей операции обязателен.
 * Если сумма требует одобрения — нужно одобрение, и отмечает не тот, кто одобрил.
 */
export async function completeManualLeg(pool: Pool, legId: string, ctx: ActionCtx, input: { note: string; reference: string }): Promise<TransactionView> {
  const payoutId = await withTransaction(pool, async (c) => {
    const leg = await lockManualLeg(c, legId);
    if (leg.needsApproval && !leg.approved_by) {
      throw new ManualLegError('approval_required', 'Сумма требует одобрения вторым сотрудником — сначала «Одобрить»');
    }
    if (leg.needsApproval && leg.approved_by === ctx.userId) {
      throw new ManualLegError('same_person', 'Одобрил ты — отметить выполненной должен другой сотрудник');
    }
    await c.query(
      `UPDATE payout_legs SET status = 'success', completed_at = now(), completed_by = $2, reference = $3,
         note = coalesce(note || ' · ', '') || $4 WHERE id = $1`, [legId, ctx.userId, input.reference, input.note]);
    await ledgerOut(c, leg.payout_id, `manual:${leg.operator_id}`, leg.amount);
    await audit(c, { userId: ctx.userId, action: 'payout.manual_complete', entity: 'payout', entityId: leg.payout_id, ip: ctx.ip,
      after: { legId, amount: leg.amount, reference: input.reference, note: input.note } });
    return leg.payout_id as string;
  });
  return finalize(pool, payoutId);
}

/** Итог выплаты: все части выполнены — успех; есть ручные в ожидании — сайт узнаёт, что нужна ручная выплата. */
async function finalize(pool: Pool, payoutId: string): Promise<TransactionView> {
  await withTransaction(pool, async (c) => {
    const tx = (await c.query(`SELECT status FROM transactions WHERE id = $1 FOR UPDATE`, [payoutId])).rows[0];
    if (tx.status !== 'pending') return;
    const legs = (await c.query(`SELECT kind, status FROM payout_legs WHERE payout_id = $1`, [payoutId])).rows;
    const open = legs.filter((l) => l.status === 'pending');
    if (open.length === 0) {
      await c.query(`UPDATE transactions SET status = 'success', updated_at = now() WHERE id = $1`, [payoutId]);
      await enqueueSiteEvent(c, (await getTransactionById(c, payoutId))!, 'payout.succeeded');
    } else if (open.every((l) => l.kind === 'manual')) {
      // Сообщаем один раз: когда автоматическая часть закончилась и остались только ручные.
      const already = (await c.query(
        `SELECT 1 FROM webhook_deliveries WHERE transaction_id = $1 AND event = 'payout.requires_manual'`, [payoutId])).rows[0];
      if (!already) await enqueueSiteEvent(c, (await getTransactionById(c, payoutId))!, 'payout.requires_manual');
    }
  });
  return (await getTransactionById(pool, payoutId))!;
}

export async function getPayoutLegs(pool: Pool | Client, payoutId: string): Promise<PayoutLegView[]> {
  return (await pool.query(`SELECT id, kind, amount, status FROM payout_legs WHERE payout_id = $1 ORDER BY kind, created_at`, [payoutId])).rows;
}

/** Повторно запустить исполнение зависших выплат (например, после перезапуска сервера между резервом и отправкой). */
export async function resumePayouts(d: PaymentDeps, olderThanSec = 60): Promise<number> {
  const ids = (await d.pool.query(
    `SELECT DISTINCT payout_id FROM payout_legs WHERE kind = 'refund' AND status = 'pending' AND submitted_at IS NULL
       AND created_at < now() - make_interval(secs => $1) LIMIT 50`, [olderThanSec])).rows.map((r) => r.payout_id as string);
  for (const id of ids) await executePayout(d, id);
  return ids.length;
}
