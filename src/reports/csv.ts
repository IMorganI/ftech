import { currencyFromViva } from '../providers/viva.js';

/*
 * Разбор выписки провайдера (CSV): разделитель определяется сам (, ; или табуляция), кавычки, BOM.
 * Колонки сопоставляются с нашими полями по названиям (на разных языках и у разных провайдеров по-разному);
 * сопоставление можно поправить вручную, и оно запоминается для провайдера.
 */

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n/) === -1 ? src.length : src.search(/\r?\n/));
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const sep = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0]!;
  const out: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) out.push(row);
  const [headers = [], ...rows] = out;
  return { headers: headers.map((h) => h.trim()), rows };
}

export const FIELDS = ['ref', 'operationId', 'type', 'status', 'amount', 'currency', 'fee', 'date', 'caseRef', 'reason'] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, string | null>>; // поле → название колонки

export const FIELD_TITLES: Record<Field, string> = {
  ref: 'ID платежа у провайдера (заказа)', operationId: 'ID операции', type: 'Тип операции', status: 'Статус',
  amount: 'Сумма', currency: 'Валюта', fee: 'Комиссия провайдера', date: 'Дата', caseRef: 'ID спора', reason: 'Код причины',
};

const ALIASES: Record<Field, string[]> = {
  ref: ['order code', 'ordercode', 'order id', 'orderid', 'order', 'payment id', 'paymentid', 'payment', 'merchant order id', 'checkout id', 'provider ref', 'id заказа', 'код заказа'],
  operationId: ['transaction id', 'transactionid', 'txn id', 'operation id', 'operationid', 'id операции', 'psp reference', 'id'],
  type: ['type', 'transaction type', 'transactiontype', 'operation type', 'event', 'record type', 'тип', 'тип операции'],
  status: ['status', 'state', 'result', 'статус'],
  amount: ['amount', 'gross', 'gross amount', 'transaction amount', 'value', 'total', 'сумма'],
  currency: ['currency', 'currency code', 'currencycode', 'ccy', 'валюта'],
  fee: ['fee', 'fees', 'commission', 'processing fee', 'total fee', 'комиссия'],
  date: ['date', 'created', 'created at', 'createdat', 'transaction date', 'insdate', 'datetime', 'time', 'дата'],
  caseRef: ['case id', 'caseid', 'dispute id', 'disputeid', 'chargeback id', 'case', 'id спора'],
  reason: ['reason code', 'reasoncode', 'reason', 'причина', 'код причины'],
};

const norm = (s: string) => s.toLowerCase().replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim();

export function autoMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<string>();
  for (const f of FIELDS) {
    for (const alias of ALIASES[f]) {
      const h = headers.find((x) => norm(x) === alias && !used.has(x));
      if (h) { m[f] = h; used.add(h); break; }
    }
    m[f] ??= null;
  }
  return m;
}

export interface ReportRow {
  lineNo: number;
  kind: 'payment' | 'refund' | 'chargeback' | 'fee' | 'other';
  status: 'success' | 'failed' | 'other';
  ref: string | null;
  operationId: string | null;
  amount: bigint | null;
  currency: string | null;
  fee: bigint;
  date: Date | null;
  caseRef: string | null;
  reason: string | null;
}

/** Сумма из отчёта в минорных единицах. «1 234,56», «1,234.56», «-15.00», «1050» (если суммы в центах). */
export function parseAmount(v: string | undefined, unit: 'major' | 'minor'): bigint | null {
  if (v === undefined) return null;
  const s = v.replace(/[\s\u00a0']/g, '').replace(/^[+-]/, '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (unit === 'minor') return /^\d+$/.test(s) ? BigInt(s) : null;
  const dots = (s.match(/\./g) ?? []).length; const commas = (s.match(/,/g) ?? []).length;
  let dec: string | null = null;
  if (dots && commas) dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';      // 1,234.56 / 1.234,56
  else if (dots + commas === 1) {
    const sep = dots ? '.' : ',';
    if (s.length - s.indexOf(sep) - 1 <= 2) dec = sep;                                   // 12.5 / 12,50 (а 1,234 — тысячи)
  }
  let whole = s; let frac = '';
  if (dec) { const k = s.lastIndexOf(dec); whole = s.slice(0, k); frac = s.slice(k + 1); }
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(whole) || !/^\d{0,2}$/.test(frac)) return null;
  return BigInt(whole || '0') * 100n + BigInt((frac + '00').slice(0, 2));
}

const kindOf = (v: string): ReportRow['kind'] => {
  const t = norm(v);
  if (/chargeback|dispute|retrieval|чарджбэк|спор/.test(t)) return 'chargeback';
  if (/refund|reversal|void|возврат/.test(t)) return 'refund';
  if (/fee|commission|комисси/.test(t)) return 'fee';
  if (!t || /payment|charge|sale|purchase|capture|deposit|оплат|платеж|платёж/.test(t)) return 'payment';
  return 'other';
};
const statusOf = (v: string): ReportRow['status'] => {
  const t = norm(v);
  if (!t || /^(f|success|successful|succeeded|completed|complete|settled|paid|approved|captured|ok|успешн.*|оплачен.*)$/.test(t)) return 'success';
  if (/^(e|failed|declined|error|cancel+ed|rejected|expired|отказ.*|ошибка)$/.test(t)) return 'failed';
  return 'other';
};

export function normalizeRows(headers: string[], rows: string[][], mapping: Mapping, unit: 'major' | 'minor'): ReportRow[] {
  const idx = Object.fromEntries(FIELDS.map((f) => [f, mapping[f] ? headers.indexOf(mapping[f]!) : -1])) as Record<Field, number>;
  const get = (r: string[], f: Field) => (idx[f] >= 0 ? (r[idx[f]] ?? '').trim() : undefined);
  return rows.map((r, i) => {
    const rawAmount = get(r, 'amount');
    const negative = !!rawAmount && /^\s*-/.test(rawAmount);
    let kind = kindOf(get(r, 'type') ?? '');
    if (kind === 'payment' && negative && idx.type < 0) kind = 'refund'; // без колонки типа: минус — возврат
    const d = get(r, 'date');
    const date = d ? new Date(/^\d{2}[./]\d{2}[./]\d{4}/.test(d) ? d.replace(/^(\d{2})[./](\d{2})[./](\d{4})/, '$3-$2-$1') : d) : null;
    return {
      lineNo: i + 2, kind, status: statusOf(get(r, 'status') ?? ''),
      ref: get(r, 'ref') || null, operationId: get(r, 'operationId') || null,
      amount: parseAmount(rawAmount, unit),
      currency: currencyFromViva((get(r, 'currency') ?? '').toUpperCase()),
      fee: parseAmount(get(r, 'fee'), unit) ?? 0n,
      date: date && !Number.isNaN(date.getTime()) ? date : null,
      caseRef: get(r, 'caseRef') || null, reason: get(r, 'reason') || null,
    };
  });
}
