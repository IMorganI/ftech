import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { audit } from '../admin/auth.js';
import { openChargeback } from '../chargebacks/chargebacks.js';
import { normalizeRows, parseCsv, type Mapping, type ReportRow } from './csv.js';

/*
 * Сверка выписки провайдера с нашими данными по одному мерчант-аккаунту.
 *
 *  Оплата (успешная) у провайдера:
 *    нет у нас                       → bad  «Провайдер получил деньги, у нас такого платежа нет»
 *    у нас не зачислена              → bad  «Оплачено у провайдера, у нас не зачислено»
 *    сумма/валюта не совпадают       → bad
 *    совпадает                       → ok
 *  Оплата (отказ) у провайдера, а у нас успех → bad.
 *  Возврат: ищем наш выполненный возврат по этому заказу с той же суммой → ok; иначе bad.
 *  Чарджбэк: заводим в «Чарджбэки» (если ещё нет) → warn; по платежу, которого у нас нет → bad.
 *  Наши успешные депозиты и возвраты за период выписки, которых в ней нет → warn (возможно, попадут в следующую).
 *  Комиссии: сумма по выписке против нашей оценки по ставке аккаунта.
 */

type Severity = 'ok' | 'info' | 'warn' | 'bad';
interface Line {
  lineNo: number | null; kind: string; status: string; ref: string | null; operationId: string | null;
  amount: bigint | null; currency: string | null; fee: bigint | null; date: Date | null; caseRef: string | null;
  result: string; severity: Severity; details: string; transactionId: string | null;
}

const fmt = (c: bigint | null, cur: string | null) => (c === null ? '?' : `${c / 100n}.${(c % 100n).toString().padStart(2, '0')} ${cur ?? ''}`.trim());

export interface ImportInput {
  accountId: string; filename: string; csv: string; mapping: Mapping; amountUnit: 'major' | 'minor';
  userId: string; ip?: string; remember?: boolean;
}

export async function importReport(pool: Pool, inp: ImportInput) {
  const { headers, rows } = parseCsv(inp.csv);
  const report = normalizeRows(headers, rows, inp.mapping, inp.amountUnit);
  const acc = (await pool.query(`SELECT m.id, m.name, m.provider_id, m.currencies[1] AS currency FROM merchant_accounts m WHERE m.id = $1`, [inp.accountId])).rows[0];
  if (!acc) throw new Error('Аккаунт не найден');

  const refs = [...new Set(report.map((r) => r.ref).filter(Boolean))] as string[];
  // Наши попытки по этому аккаунту для ID из выписки.
  const ours = new Map<string, { tx_id: string; att_status: string; tx_status: string; amount: bigint; currency: string; provider_fee: bigint | null }>();
  for (const r of (await pool.query(
    `SELECT a.provider_ref, a.status AS att_status, t.id AS tx_id, t.status AS tx_status, t.amount, t.currency, t.provider_fee
     FROM transaction_attempts a JOIN transactions t ON t.id = a.transaction_id
     WHERE a.merchant_account_id = $1 AND a.provider_ref = ANY($2::text[])`, [acc.id, refs])).rows) {
    ours.set(r.provider_ref, { ...r, currency: r.currency.trim() });
  }
  // Наши выполненные возвраты по этим заказам.
  const refunds = (await pool.query(
    `SELECT l.id, l.amount, a.provider_ref, l.payout_id, l.completed_at FROM payout_legs l
     JOIN transaction_attempts a ON a.transaction_id = l.deposit_id AND a.status = 'success'
     WHERE l.kind = 'refund' AND l.status = 'success' AND l.merchant_account_id = $1`, [acc.id])).rows;
  const usedRefunds = new Set<string>();

  const lines: Line[] = [];
  const add = (r: ReportRow, result: string, severity: Severity, details: string, transactionId: string | null = null) =>
    lines.push({ lineNo: r.lineNo, kind: r.kind, status: r.status, ref: r.ref, operationId: r.operationId, amount: r.amount,
      currency: r.currency, fee: r.fee, date: r.date, caseRef: r.caseRef, result, severity, details, transactionId });

  let reportFees = 0n; let ourFees = 0n;
  const seenPayments = new Set<string>();
  for (const r of report) {
    reportFees += r.fee;
    const o = r.ref ? ours.get(r.ref) : undefined;
    if (r.kind === 'payment') {
      if (r.status === 'success') {
        if (r.ref) seenPayments.add(r.ref);
        if (!o) add(r, 'unknown_to_us', 'bad', 'Провайдер получил оплату, а у нас платежа с таким ID на этом аккаунте нет');
        else if (o.att_status !== 'success' || o.tx_status !== 'success') add(r, 'not_credited', 'bad', `Оплачено у провайдера, у нас статус «${o.tx_status}» — деньги не зачислены`, o.tx_id);
        else if (r.amount !== o.amount || (r.currency && r.currency !== o.currency)) add(r, 'amount_mismatch', 'bad', `У провайдера ${fmt(r.amount, r.currency)}, у нас ${fmt(o.amount, o.currency)}`, o.tx_id);
        else { add(r, 'matched', 'ok', 'Совпадает', o.tx_id); ourFees += o.provider_fee ?? 0n; }
      } else if (r.status === 'failed') {
        if (o && o.tx_status === 'success' && o.att_status === 'success') add(r, 'status_mismatch', 'bad', 'У провайдера оплата не прошла, а у нас зачислена', o.tx_id);
        else add(r, 'matched_failed', 'info', 'Неуспешная оплата — у нас тоже не зачислена', o?.tx_id ?? null);
      } else add(r, 'other_status', 'info', 'Статус не распознан — строка не сверялась', o?.tx_id ?? null);
    } else if (r.kind === 'refund') {
      if (r.status === 'failed') { add(r, 'refund_failed', 'info', 'Неуспешный возврат', o?.tx_id ?? null); continue; }
      const match = refunds.find((x) => x.provider_ref === r.ref && BigInt(x.amount) === r.amount && !usedRefunds.has(x.id));
      if (match) { usedRefunds.add(match.id); add(r, 'matched', 'ok', 'Совпадает с нашим возвратом', match.payout_id); }
      else add(r, 'refund_unknown', 'bad', 'Провайдер вернул деньги, а у нас такого возврата нет', o?.tx_id ?? null);
    } else if (r.kind === 'chargeback') {
      if (!o || o.tx_status !== 'success') { add(r, 'unknown_to_us', 'bad', 'Чарджбэк по платежу, который у нас не зачислен или не найден', o?.tx_id ?? null); continue; }
      try {
        const cb = await openChargeback(pool, { transactionId: o.tx_id, amount: r.amount ?? undefined, caseRef: r.caseRef ?? `report:${r.ref}:${r.amount}`,
          reasonCode: r.reason, source: 'report' }, { userId: inp.userId });
        add(r, cb.created ? 'chargeback_opened' : 'chargeback_known', cb.created ? 'warn' : 'ok',
          cb.created ? 'Новый чарджбэк — заведён в «Чарджбэках», ответь провайдеру в срок' : 'Чарджбэк уже учтён', o.tx_id);
      } catch (err) { add(r, 'chargeback_error', 'bad', `Не удалось завести чарджбэк: ${(err as Error).message}`, o.tx_id); }
    } else if (r.kind === 'fee') add(r, 'fee', 'info', 'Комиссия провайдера');
    else add(r, 'skipped', 'info', 'Тип операции не распознан — строка не сверялась');
  }

  // Наши операции за период выписки, которых в ней нет.
  const dates = report.map((r) => r.date).filter((d): d is Date => !!d).sort((a, b) => +a - +b);
  const from = dates[0] ?? null; const to = dates.at(-1) ?? null;
  if (from && to) {
    for (const t of (await pool.query(
      `SELECT a.provider_ref, t.id, t.amount, t.currency, t.created_at FROM transaction_attempts a JOIN transactions t ON t.id = a.transaction_id
       WHERE a.merchant_account_id = $1 AND a.status = 'success' AND t.status = 'success' AND t.created_at BETWEEN $2 AND $3`,
      [acc.id, from, to])).rows) {
      if (!seenPayments.has(t.provider_ref)) {
        lines.push({ lineNo: null, kind: 'payment', status: 'success', ref: t.provider_ref, operationId: null, amount: BigInt(t.amount),
          currency: t.currency.trim(), fee: null, date: t.created_at, caseRef: null, result: 'missing_in_report', severity: 'warn',
          details: 'У нас зачислено, а в выписке нет — проверь у провайдера (может попасть в следующую выписку)', transactionId: t.id });
      }
    }
    for (const x of refunds) {
      if (!usedRefunds.has(x.id) && x.completed_at >= from && x.completed_at <= to) {
        lines.push({ lineNo: null, kind: 'refund', status: 'success', ref: x.provider_ref, operationId: null, amount: BigInt(x.amount),
          currency: acc.currency?.trim() ?? null, fee: null, date: x.completed_at, caseRef: null, result: 'missing_in_report', severity: 'warn',
          details: 'У нас возврат выполнен, а в выписке его нет', transactionId: x.payout_id });
      }
    }
  }

  const count = (sev: Severity) => lines.filter((l) => l.severity === sev).length;
  const sumOk = (kind: string) => lines.filter((l) => l.kind === kind && l.result === 'matched').reduce((s, l) => s + (l.amount ?? 0n), 0n);
  const summary = {
    rows: report.length, ok: count('ok'), info: count('info'), warn: count('warn'), bad: count('bad'),
    matchedPayments: sumOk('payment').toString(), matchedRefunds: sumOk('refund').toString(),
    fees: { report: reportFees.toString(), ours: ourFees.toString(), diff: (reportFees - ourFees).toString() },
    currency: acc.currency?.trim() ?? null,
  };

  return withTransaction(pool, async (c) => {
    const id = (await c.query(
      `INSERT INTO report_imports (merchant_account_id, filename, uploaded_by, period_from, period_to, rows_total, mapping, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [acc.id, inp.filename, inp.userId, from, to, report.length, JSON.stringify({ ...inp.mapping, _unit: inp.amountUnit }), JSON.stringify(summary)])).rows[0].id as string;
    for (const l of lines) {
      await c.query(
        `INSERT INTO report_lines (import_id, line_no, kind, status, provider_ref, operation_id, amount, currency, fee, occurred_at, case_ref, result, severity, details, transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [id, l.lineNo, l.kind, l.status, l.ref, l.operationId, l.amount, l.currency, l.fee, l.date, l.caseRef, l.result, l.severity, l.details, l.transactionId]);
    }
    if (inp.remember !== false) {
      await c.query(
        `INSERT INTO report_mappings (provider_id, mapping, amount_unit) VALUES ($1, $2, $3)
         ON CONFLICT (provider_id) DO UPDATE SET mapping = EXCLUDED.mapping, amount_unit = EXCLUDED.amount_unit, updated_at = now()`,
        [acc.provider_id, JSON.stringify(inp.mapping), inp.amountUnit]);
    }
    await audit(c, { userId: inp.userId, action: 'report.import', entity: 'report', entityId: id, ip: inp.ip,
      after: { account: acc.name, filename: inp.filename, ...summary } });
    return { id, summary };
  });
}
