import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import { requireAdmin, bigintReplacer, type AdminDeps } from './auth.js';

/*
 * Что происходит с деньгами:
 *  - история платежа: все события по порядку (запрос сайта, выбор аккаунта, отправка провайдеру,
 *    вебхуки провайдера, проводки, уведомления сайту, проблемы, действия сотрудников) и что можно сделать сейчас;
 *  - «зависшие деньги»: где и сколько денег ждёт, как давно и что делать.
 */

type Tone = 'ok' | 'bad' | 'warn' | 'info';
export interface TimelineEvent { at: Date; tone: Tone; title: string; detail?: string | null; actor?: string | null; kind: string }
export interface NextStep { text: string; tab?: string; who: 'system' | 'staff' | 'site' }

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v, bigintReplacer));
const fmt = (cents: bigint | string | number, cur: string) => {
  const n = BigInt(cents); const neg = n < 0n; const a = neg ? -n : n;
  return `${neg ? '−' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${(a % 100n).toString().padStart(2, '0')} ${cur.trim()}`;
};
const ago = (d: Date) => {
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  return m < 60 ? `${m} мин` : m < 2880 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} дн`;
};

const DECLINE: Record<string, string> = {
  player_self_excluded: 'игрок в самоисключении', country_not_licensed: 'страна игрока вне лицензии', kyc_rejected: 'KYC отклонён',
  kyc_required: 'нужен подтверждённый KYC', player_limit_exceeded: 'превышен лимит игрока', no_route: 'нет подходящего аккаунта',
  all_attempts_failed: 'отказ на всех попытках', provider_unavailable: 'провайдер не ответил, срок оплаты истёк — без каскада',
  amount_over_limit: 'больше максимальной выплаты оператора',
};
const HOOK: Record<string, [Tone, string]> = {
  accepted: ['ok', 'принят'], test: ['ok', 'тестовое событие'], duplicate: ['info', 'повтор'], challenge: ['info', 'проверка адреса'],
  rejected: ['bad', 'отклонён'], error: ['bad', 'ошибка обработки'],
};
const AUDIT: Record<string, string> = {
  'payout.manual_approve': 'Одобрил ручную выплату', 'payout.manual_complete': 'Отметил ручную выплату выполненной',
};

export async function paymentTimeline(pool: Pool, txId: string) {
  const tx = (await pool.query(
    `SELECT t.*, s.name AS site, o.name AS operator, p.external_id AS player, p.country
     FROM transactions t JOIN sites s ON s.id = t.site_id JOIN operators o ON o.id = s.operator_id JOIN players p ON p.id = t.player_id
     WHERE t.id = $1`, [txId])).rows[0];
  if (!tx) return null;
  const cur = (tx.currency as string).trim();
  const ev: (TimelineEvent & { seq: number })[] = [];
  // События одной транзакции базы имеют одно время — тогда порядок задаёт последовательность шагов.
  const push = (e: TimelineEvent) => { if (e.at) ev.push({ ...e, seq: ev.length }); };

  push({ at: tx.created_at, kind: 'request', tone: 'info',
    title: tx.type === 'deposit' ? `Сайт ${tx.site} запросил депозит ${fmt(tx.amount, cur)}` : `Сайт ${tx.site} запросил выплату ${fmt(tx.amount, cur)}`,
    detail: `Игрок ${tx.player} · ${tx.country.trim()} · оператор ${tx.operator}${tx.withdrawal_id ? ` · вывод ${tx.withdrawal_id}` : ''} · ключ запроса ${tx.idempotency_key}` });

  // --- попытки депозита ---
  const attempts = (await pool.query(
    `SELECT a.*, m.name AS account, p.name AS provider FROM transaction_attempts a
     JOIN merchant_accounts m ON m.id = a.merchant_account_id JOIN providers p ON p.id = m.provider_id
     WHERE a.transaction_id = $1 ORDER BY a.attempt_no`, [txId])).rows;
  attempts.forEach((a, i) => {
    push({ at: a.created_at, kind: 'route', tone: 'info', title: `Попытка ${a.attempt_no}: выбран аккаунт «${a.account}» (${a.provider})`, detail: a.route_reason });
    if (a.submitted_at) {
      const o = a.submit_outcome ?? (a.provider_ref ? 'created' : null);
      push(o === 'created' ? { at: a.submitted_at, kind: 'submit', tone: 'ok', title: 'Провайдер создал платёж', detail: `ID у провайдера: ${a.provider_ref}` }
        : o === 'declined' ? { at: a.submitted_at, kind: 'submit', tone: 'warn', title: 'Провайдер сразу отказал — платёж не создан', detail: a.error }
        : { at: a.submitted_at, kind: 'submit', tone: 'bad', title: 'Ответ провайдера на создание потерян',
            detail: `${a.error ?? 'процесс прервался во время отправки'}. Каскад запрещён, пока не выяснится, создан ли платёж. Наш ID попытки для поиска у провайдера: ${a.id}` });
    }
    if (a.status !== 'pending') {
      const at = attempts[i + 1]?.created_at ?? tx.updated_at;
      push(a.status === 'success'
        ? { at, kind: 'result', tone: 'ok', title: `Оплата подтверждена провайдером (аккаунт «${a.account}»)` }
        : { at, kind: 'result', tone: 'warn', title: `Попытка ${a.attempt_no} закрыта отказом`, detail: a.error });
    } else if (a.error && /^(amount_mismatch|unverified)/.test(a.error)) {
      push({ at: tx.updated_at, kind: 'result', tone: 'bad', title: 'Оплата не зачислена — нужна ручная проверка', detail: a.error });
    }
  });

  // --- вебхуки провайдера по этому платежу ---
  const refs = attempts.filter((a) => a.provider_ref).map((a) => [a.merchant_account_id, a.provider_ref]);
  if (refs.length) {
    for (const r of (await pool.query(
      `SELECT l.received_at, l.outcome, l.reason, l.event_id FROM provider_webhook_log l
       JOIN unnest($1::uuid[], $2::text[]) k(acc, ref) ON l.merchant_account_id = k.acc AND l.provider_ref = k.ref
       ORDER BY l.received_at`, [refs.map((x) => x[0]), refs.map((x) => x[1])])).rows) {
      const [tone, label] = HOOK[r.outcome] ?? ['info', r.outcome];
      push({ at: r.received_at, kind: 'provider_webhook', tone, title: `Вебхук провайдера: ${label}`, detail: r.reason });
    }
  }

  // --- выплата: части ---
  const legs = (await pool.query(
    `SELECT l.*, m.name AS account, u.email AS completed_email, ua.email AS approved_email FROM payout_legs l
     LEFT JOIN merchant_accounts m ON m.id = l.merchant_account_id LEFT JOIN admin_users u ON u.id = l.completed_by
     LEFT JOIN admin_users ua ON ua.id = l.approved_by WHERE l.payout_id = $1 ORDER BY l.created_at, l.kind`, [txId])).rows;
  for (const l of legs) {
    const what = l.kind === 'refund' ? `Возврат на карту ${fmt(l.amount, cur)} через «${l.account}»` : `Ручная выплата ${fmt(l.amount, cur)}`;
    push({ at: l.created_at, kind: 'leg', tone: 'info', title: `Часть выплаты: ${what}` });
    if (l.kind === 'refund' && l.submitted_at) push({ at: l.submitted_at, kind: 'leg', tone: 'info', title: 'Возврат отправлен провайдеру' });
    if (l.approved_at) push({ at: l.approved_at, kind: 'leg', tone: 'ok', title: 'Ручная выплата одобрена', actor: l.approved_email });
    if (l.completed_at) {
      push(l.status === 'success'
        ? { at: l.completed_at, kind: 'leg', tone: 'ok', title: l.kind === 'refund' ? 'Возврат выполнен' : 'Ручная выплата выполнена',
            detail: [l.reference ? `№ ${l.reference}` : null, l.provider_ref ? `ID у провайдера ${l.provider_ref}` : null, l.note].filter(Boolean).join(' · ') || null,
            actor: l.completed_email }
        : { at: l.completed_at, kind: 'leg', tone: 'warn', title: 'Возврат не прошёл — часть стала ручной', detail: l.error });
    }
  }

  // --- проводки ---
  const ledger = (await pool.query(`SELECT account, amount, currency, created_at FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`, [txId])).rows;
  const byTime = new Map<number, typeof ledger>();
  for (const l of ledger) { const k = +l.created_at; byTime.set(k, [...(byTime.get(k) ?? []), l]); }
  for (const [, rows] of byTime) {
    const sum = rows.reduce((s, r) => s + BigInt(r.amount), 0n);
    push({ at: rows[0].created_at, kind: 'ledger', tone: sum === 0n ? 'ok' : 'bad', title: `Проводки${sum === 0n ? ' (сходятся)' : ' НЕ СХОДЯТСЯ'}`,
      detail: rows.map((r) => `${r.account.split(':')[0]} ${BigInt(r.amount) > 0n ? '+' : ''}${fmt(r.amount, r.currency)}`).join(' · ') });
  }

  // --- уведомления сайту ---
  const deliveries = (await pool.query(`SELECT event, status, attempts, last_error, created_at, delivered_at, next_attempt_at FROM webhook_deliveries WHERE transaction_id = $1 ORDER BY id`, [txId])).rows;
  for (const w of deliveries) {
    if (w.status === 'delivered') push({ at: w.delivered_at, kind: 'site_webhook', tone: 'ok', title: `Сайт получил уведомление ${w.event}`, detail: w.attempts > 1 ? `с ${w.attempts}-й попытки` : null });
    else if (w.status === 'failed') push({ at: w.next_attempt_at ?? w.created_at, kind: 'site_webhook', tone: 'bad', title: `Сайт не получил уведомление ${w.event}`, detail: `${w.attempts} попыток: ${w.last_error ?? ''}` });
    else push({ at: w.created_at, kind: 'site_webhook', tone: 'info', title: `Уведомление сайту ${w.event} в очереди`, detail: w.attempts ? `попыток: ${w.attempts}, ошибка: ${w.last_error ?? '—'}` : null });
  }

  // --- проблемы и действия сотрудников ---
  const issues = (await pool.query(
    `SELECT i.*, u.email AS resolved_email FROM reconciliation_issues i LEFT JOIN admin_users u ON u.id = i.resolved_by WHERE i.transaction_id = $1 ORDER BY i.id`, [txId])).rows;
  for (const i of issues) {
    push({ at: i.created_at, kind: 'issue', tone: 'bad', title: 'Проблема для ручной проверки', detail: i.details });
    if (i.resolved) push({ at: i.resolved_at, kind: 'issue', tone: 'ok', title: 'Проблема закрыта', detail: i.resolution_note, actor: i.resolved_email });
  }
  for (const a of (await pool.query(
    `SELECT l.action, l.created_at, l.after, u.email FROM audit_log l LEFT JOIN admin_users u ON u.id = l.admin_user_id
     WHERE l.entity IN ('payout', 'transaction') AND l.entity_id = $1::text
       AND l.action NOT IN ('payout.manual_approve', 'payout.manual_complete') -- уже показаны в частях выплаты, с именем
     ORDER BY l.id`, [txId])).rows) {
    push({ at: a.created_at, kind: 'staff', tone: 'info', title: AUDIT[a.action] ?? a.action, actor: a.email });
  }

  ev.sort((x, y) => +x.at - +y.at || x.seq - y.seq);
  const { state, next } = assess(tx, attempts, legs, issues, deliveries);
  return plain({
    id: tx.id, type: tx.type, status: tx.status, amount: tx.amount, currency: cur, declineCode: tx.decline_code,
    site: tx.site, operator: tx.operator, player: tx.player, country: tx.country.trim(), withdrawalId: tx.withdrawal_id,
    createdAt: tx.created_at, platformFee: tx.platform_fee, providerFee: tx.provider_fee, refunded: tx.refunded_amount,
    state, next, events: ev.map(({ seq: _seq, ...e }) => e),
  });
}


/** Где сейчас деньги этого платежа и что можно сделать. */
function assess(tx: any, attempts: any[], legs: any[], issues: any[], deliveries: any[]): { state: { tone: Tone; title: string; detail: string }; next: NextStep[] } {
  const cur = tx.currency.trim();
  const next: NextStep[] = [];
  const openIssues = issues.filter((i) => !i.resolved);
  if (openIssues.length) next.push({ who: 'staff', tab: 'issues', text: 'Проверь платёж в кабинете провайдера и закрой проблему в «Проблемах» с описанием, что сделано' });
  const failedDelivery = deliveries.some((w) => w.status === 'failed');
  if (failedDelivery) next.push({ who: 'staff', tab: 'connect', text: 'Сайт не получил уведомление — проверь адрес вебхука сайта; статус сайт может узнать запросом GET' });

  if (tx.type === 'deposit') {
    if (tx.status === 'success') return { state: { tone: 'ok', title: 'Зачислен', detail: `Деньги на аккаунте провайдера; платформа заработала ${fmt(tx.platform_fee ?? 0, cur)}` }, next };
    if (tx.status === 'declined') {
      if (tx.decline_code === 'provider_unavailable') next.push({ who: 'site', text: 'Сайт может предложить игроку создать новый депозит' });
      return { state: { tone: 'warn', title: 'Отклонён', detail: DECLINE[tx.decline_code] ?? tx.decline_code ?? '' }, next };
    }
    const a = attempts.find((x) => x.status === 'pending');
    if (!a) return { state: { tone: 'info', title: 'Создан', detail: 'Ждёт выбора аккаунта' }, next };
    if (a.error && /^(amount_mismatch|unverified)/.test(a.error)) {
      return { state: { tone: 'bad', title: 'Оплачен, но не зачислен', detail: 'Провайдер не подтвердил сумму или валюту, либо они не совпадают. Сверка этот платёж не трогает.' }, next };
    }
    if (!a.submitted_at) {
      next.unshift({ who: 'system', text: 'Отправится провайдеру автоматически при следующей сверке' });
      return { state: { tone: 'warn', title: 'Не отправлен провайдеру', detail: `Резерв лимита держится ${ago(a.created_at)}` }, next };
    }
    if (!a.provider_ref) {
      next.unshift({ who: 'system', text: 'Система ищет платёж у провайдера по нашему ID попытки; если провайдер не умеет искать — закроет отказом без каскада после истечения срока оплаты заказа' },
        { who: 'staff', text: `Можно найти платёж в кабинете провайдера по нашему ID: ${a.id}` });
      return { state: { tone: 'bad', title: 'Отправка не подтверждена', detail: `Ответ провайдера потерян ${ago(a.submitted_at)} назад. Платёж мог быть создан — поэтому на другой аккаунт не перекидываем.` }, next };
    }
    next.unshift({ who: 'system', text: 'Ждём вебхук провайдера; если он не придёт, сверка сама спросит статус у провайдера' });
    return { state: { tone: 'info', title: 'Ждёт оплаты игроком', detail: `Страница оплаты открыта ${ago(a.submitted_at)} назад, аккаунт «${a.account}»` }, next };
  }

  // выплата
  if (tx.status === 'success') return { state: { tone: 'ok', title: 'Выплачено', detail: 'Все части выполнены' }, next };
  if (tx.status === 'declined') return { state: { tone: 'warn', title: 'Отклонена', detail: DECLINE[tx.decline_code] ?? tx.decline_code ?? '' }, next };
  const manual = legs.filter((l) => l.kind === 'manual' && l.status === 'pending');
  const refundWaiting = legs.filter((l) => l.kind === 'refund' && l.status === 'pending');
  if (refundWaiting.some((l) => l.submitted_at)) {
    next.unshift({ who: 'staff', tab: 'issues', text: 'Провайдер не ответил на возврат: проверь в его кабинете, ушли ли деньги, и закрой проблему' });
  } else if (refundWaiting.length) next.unshift({ who: 'system', text: 'Возвраты отправятся провайдеру автоматически' });
  for (const m of manual) {
    next.unshift(m.approved_by
      ? { who: 'staff', tab: 'manual', text: `Переведи ${fmt(m.amount, cur)} игроку и отметь в «Ручных выплатах» с номером перевода (не тот, кто одобрил)` }
      : { who: 'staff', tab: 'manual', text: `Ручная выплата ${fmt(m.amount, cur)}: переведи и отметь в «Ручных выплатах» (крупные суммы — сначала одобрение)` });
  }
  const waiting = [...manual, ...refundWaiting].reduce((s, l) => s + BigInt(l.amount), 0n);
  return { state: { tone: 'warn', title: 'В процессе', detail: `Осталось выплатить ${fmt(waiting, cur)}` }, next };
}

// ---------- зависшие деньги ----------

export interface StuckCategory {
  key: string; title: string; hint: string; severity: 'bad' | 'warn' | 'info'; tab: string;
  count: number; totals: { currency: string; amount: bigint }[]; oldestAt: Date | null;
  items: { txId: string; amount: bigint; currency: string; at: Date; label: string }[];
}

export async function stuckMoney(pool: Pool): Promise<{ categories: StuckCategory[]; reserved: { currency: string; amount: bigint }[] }> {
  const cats: StuckCategory[] = [];
  const add = async (d: Omit<StuckCategory, 'count' | 'totals' | 'oldestAt' | 'items'>, sql: string) => {
    // sql отдаёт: tx_id, amount, currency, at, label
    const rows = (await pool.query(`SELECT * FROM (${sql}) q ORDER BY at`)).rows;
    const totals = new Map<string, bigint>();
    for (const r of rows) totals.set(r.currency.trim(), (totals.get(r.currency.trim()) ?? 0n) + BigInt(r.amount));
    cats.push({ ...d, count: rows.length, totals: [...totals].map(([currency, amount]) => ({ currency, amount })),
      oldestAt: rows[0]?.at ?? null,
      items: rows.slice(0, 20).map((r) => ({ txId: r.tx_id, amount: BigInt(r.amount), currency: r.currency.trim(), at: r.at, label: r.label })) });
  };

  await add({ key: 'submission_unknown', severity: 'bad', tab: 'payments', title: 'Отправка провайдеру не подтверждена',
    hint: 'Ответ провайдера потерян — платёж мог быть создан. Система ищет его сама или закроет без каскада после срока оплаты. Если висит долго — найди по ID попытки в кабинете провайдера.' },
    `SELECT t.id AS tx_id, t.amount, t.currency, a.submitted_at AS at, m.name || ': ' || coalesce(a.error, 'процесс прервался') AS label
     FROM transaction_attempts a JOIN transactions t ON t.id = a.transaction_id JOIN merchant_accounts m ON m.id = a.merchant_account_id
     WHERE a.status = 'pending' AND a.submitted_at IS NOT NULL AND a.provider_ref IS NULL AND a.submit_outcome IS DISTINCT FROM 'declined'`);

  await add({ key: 'manual_review', severity: 'bad', tab: 'issues', title: 'Оплачено, но не зачислено',
    hint: 'Провайдер не подтвердил сумму или валюту, либо они не совпали. Проверь оплату у провайдера и реши в «Проблемах».' },
    `SELECT t.id AS tx_id, t.amount, t.currency, t.updated_at AS at, a.error AS label
     FROM transaction_attempts a JOIN transactions t ON t.id = a.transaction_id
     WHERE a.status = 'pending' AND (a.error LIKE 'amount_mismatch%' OR a.error LIKE 'unverified%')`);

  await add({ key: 'refund_unknown', severity: 'bad', tab: 'issues', title: 'Возврат без ответа провайдера',
    hint: 'Неизвестно, ушли ли деньги игроку. Повторно не отправляем, чтобы не вернуть дважды: проверь в кабинете провайдера.' },
    `SELECT t.id AS tx_id, l.amount, t.currency, l.submitted_at AS at, coalesce(m.name, '') || ': ' || coalesce(l.error, 'нет ответа') AS label
     FROM payout_legs l JOIN transactions t ON t.id = l.payout_id LEFT JOIN merchant_accounts m ON m.id = l.merchant_account_id
     WHERE l.kind = 'refund' AND l.status = 'pending' AND l.submitted_at < now() - interval '5 minutes'`);

  await add({ key: 'open_issues', severity: 'bad', tab: 'issues', title: 'Открытые проблемы',
    hint: 'Расхождения с провайдером, которые решает человек.' },
    `SELECT t.id AS tx_id, t.amount, t.currency, i.created_at AS at, i.kind || ': ' || left(i.details, 120) AS label
     FROM reconciliation_issues i JOIN transactions t ON t.id = i.transaction_id WHERE NOT i.resolved`);

  await add({ key: 'manual_payouts', severity: 'warn', tab: 'manual', title: 'Ручные выплаты ждут сотрудника',
    hint: 'Выигрыш сверх депозитов: переведи игроку и отметь с номером перевода. Крупные — сначала одобрение.' },
    `SELECT t.id AS tx_id, l.amount, t.currency, l.created_at AS at,
       p.external_id || CASE WHEN l.approved_by IS NULL AND o.manual_approval_above IS NOT NULL AND l.amount >= o.manual_approval_above
                             THEN ' · нужно одобрение' WHEN l.approved_by IS NOT NULL THEN ' · одобрено' ELSE '' END AS label
     FROM payout_legs l JOIN transactions t ON t.id = l.payout_id JOIN players p ON p.id = t.player_id
     JOIN sites s ON s.id = t.site_id JOIN operators o ON o.id = s.operator_id
     WHERE l.kind = 'manual' AND l.status = 'pending'`);

  await add({ key: 'inbox', severity: 'warn', tab: 'payments', title: 'Вебхуки провайдера не обработаны',
    hint: 'Событие пришло, но обработать не удалось (провайдер не ответил на запрос статуса). Фоновая задача повторяет сама.' },
    `SELECT t.id AS tx_id, t.amount, t.currency, e.received_at AS at, 'попыток ' || e.attempts || coalesce(': ' || e.last_error, '') AS label
     FROM provider_webhook_events e JOIN transaction_attempts a ON a.merchant_account_id = e.merchant_account_id AND a.provider_ref = e.provider_ref
     JOIN transactions t ON t.id = a.transaction_id
     WHERE e.processed_at IS NULL AND e.received_at < now() - interval '2 minutes'`);

  await add({ key: 'site_webhooks', severity: 'warn', tab: 'connect', title: 'Сайт не получил уведомление',
    hint: 'Все попытки доставки исчерпаны. Проверь адрес вебхука сайта; сайт может узнать статус запросом GET.' },
    `SELECT t.id AS tx_id, t.amount, t.currency, w.created_at AS at, s.name || ' · ' || w.event || coalesce(': ' || w.last_error, '') AS label
     FROM webhook_deliveries w JOIN transactions t ON t.id = w.transaction_id JOIN sites s ON s.id = w.site_id WHERE w.status = 'failed'`);

  await add({ key: 'not_submitted', severity: 'warn', tab: 'payments', title: 'Не отправлены провайдеру',
    hint: 'Лимит зарезервирован, но запрос провайдеру не ушёл (процесс перезапускался). Сверка отправит сама.' },
    `SELECT t.id AS tx_id, t.amount, t.currency, a.created_at AS at, m.name AS label
     FROM transaction_attempts a JOIN transactions t ON t.id = a.transaction_id JOIN merchant_accounts m ON m.id = a.merchant_account_id
     WHERE a.status = 'pending' AND a.submitted_at IS NULL AND a.created_at < now() - interval '2 minutes'`);

  await add({ key: 'awaiting_player', severity: 'info', tab: 'payments', title: 'Ждут оплаты игроком дольше 15 минут',
    hint: 'Страница оплаты открыта, игрок ещё не заплатил. Обычно игрок просто ушёл — заказ закроется по сроку у провайдера, лимит освободится.' },
    `SELECT t.id AS tx_id, t.amount, t.currency, a.submitted_at AS at, m.name AS label
     FROM transaction_attempts a JOIN transactions t ON t.id = a.transaction_id JOIN merchant_accounts m ON m.id = a.merchant_account_id
     WHERE a.status = 'pending' AND a.provider_ref IS NOT NULL AND a.submitted_at < now() - interval '15 minutes'
       AND (a.error IS NULL OR (a.error NOT LIKE 'amount_mismatch%' AND a.error NOT LIKE 'unverified%'))`);

  const reserved = (await pool.query(
    `SELECT u.currency, sum(u.reserved)::bigint AS amount FROM account_usage u JOIN merchant_accounts m ON m.id = u.merchant_account_id
     WHERE u.day = (now() AT TIME ZONE m.cap_timezone)::date AND u.reserved > 0 GROUP BY u.currency ORDER BY u.currency`)).rows
    .map((r) => ({ currency: r.currency.trim(), amount: BigInt(r.amount) }));
  return { categories: cats, reserved };
}

export async function insightRoutes(app: FastifyInstance, d: AdminDeps) {
  const { pool } = d;
  const viewer = { preHandler: requireAdmin(d, 'viewer') };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: { code: 'not_found', message: 'Платёж не найден' } });

  app.get<{ Params: { id: string } }>('/admin/v1/transactions/:id/timeline', viewer, async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return notFound(reply);
    return (await paymentTimeline(pool, req.params.id)) ?? notFound(reply);
  });

  app.get('/admin/v1/stuck', viewer, async () => plain(await stuckMoney(pool)));
}
