import type { Pool } from '../db/pool.js';
import type { Sender } from './telegram.js';

/*
 * Уведомления о том, что требует внимания человека. Проверяется периодически; каждое событие
 * отправляется один раз (ключ в notifications_sent ставится только после успешной отправки).
 *
 *  - новое расхождение с провайдером (reconciliation_issues);
 *  - вебхук сайту не доставлен после всех попыток;
 *  - аккаунт дошёл до порога переключения — один раз за сутки;
 *  - провайдер не отвечает при создании платежей — не чаще раза в час на аккаунт;
 *  - отправка не подтверждена или вебхук провайдера не обработан дольше 10 минут.
 */

export interface Alert {
  key: string;
  text: string;
}

const money = (cents: bigint | string, cur?: string) => {
  const n = BigInt(cents);
  const s = `${(n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${(n % 100n).toString().padStart(2, '0')}`;
  return cur ? `${s} ${cur.trim()}` : s;
};

const ISSUE_TEXT: Record<string, string> = {
  late_success: 'провайдер подтвердил оплату по попытке, которую мы уже закрыли',
  status_mismatch: 'статус у провайдера не совпадает с нашим',
  amount_mismatch: 'оплачена не та сумма или валюта',
  unverified_payment: 'провайдер не подтвердил сумму или валюту оплаты',
  refund_unknown: 'нет ответа провайдера при возврате — проверь, ушли ли деньги',
};

export async function collectAlerts(pool: Pool, boardUrl: string): Promise<Alert[]> {
  const out: Alert[] = [];
  const sent = `NOT EXISTS (SELECT 1 FROM notifications_sent n WHERE n.key = k.key)`;

  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'issue:' || i.id AS key, i.kind, i.details, i.transaction_id
       FROM reconciliation_issues i WHERE NOT i.resolved AND i.created_at > now() - interval '7 days') k
     WHERE ${sent} ORDER BY key LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `⚠️ Проблема с платежом: ${ISSUE_TEXT[r.kind] ?? r.kind}.\n${r.details}\n\nРазобрать: ${boardUrl}#issues` });
  }

  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'delivery:' || w.id AS key, w.event, w.last_error, s.name AS site
       FROM webhook_deliveries w JOIN sites s ON s.id = w.site_id
       WHERE w.status = 'failed' AND w.created_at > now() - interval '7 days') k
     WHERE ${sent} ORDER BY key LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `📭 Сайт «${r.site}» не получил уведомление ${r.event} после всех попыток (${r.last_error ?? 'ошибка'}).\nПроверь адрес вебхука сайта: ${boardUrl}#connect` });
  }

  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'manual_payout:' || l.id AS key, l.amount, t.currency, s.name AS site, p.external_id AS player
       FROM payout_legs l JOIN transactions t ON t.id = l.payout_id JOIN sites s ON s.id = t.site_id JOIN players p ON p.id = t.player_id
       WHERE l.kind = 'manual' AND l.status = 'pending') k
     WHERE ${sent} ORDER BY key LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `💸 Нужна ручная выплата: ${money(r.amount, r.currency)} игроку ${r.player} (сайт «${r.site}»). Сверх возвратов на карту — переведи сам и отметь в борде: ${boardUrl}#manual` });
  }

  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'acc_full:' || m.id || ':' || u.day AS key, m.name, u.used, u.reserved, m.daily_cap, m.switch_at_bps
       FROM merchant_accounts m JOIN account_usage u ON u.merchant_account_id = m.id
         AND u.day = (now() AT TIME ZONE m.cap_timezone)::date AND u.currency = m.currencies[1]
       WHERE m.enabled AND (u.used + u.reserved) * 10000 >= m.daily_cap * m.switch_at_bps) k
     WHERE ${sent} LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `📈 Аккаунт «${r.name}» дошёл до ${r.switch_at_bps / 100}% дневного лимита (${money(r.used)} из ${money(r.daily_cap)}). Новые платежи идут на другие аккаунты.\n${boardUrl}#accounts` });
  }

  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'prov_err:' || m.id || ':' || to_char(date_trunc('hour', now()), 'YYYY-MM-DD"T"HH24') AS key,
         m.name, count(*)::int AS n, max(a.error) AS error
       FROM transaction_attempts a JOIN merchant_accounts m ON m.id = a.merchant_account_id
       WHERE a.error LIKE 'submission_unknown:%' AND a.created_at > now() - interval '15 minutes'
       GROUP BY m.id, m.name) k
     WHERE ${sent} LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `🔌 Провайдер не отвечает: аккаунт «${r.name}», ${r.n} сбо(я/ев) за 15 минут.\nПоследняя ошибка: ${String(r.error).slice(0, 200)}\nПлатежи ждут сверки. ${boardUrl}#payments` });
  }
  // Отправка не подтверждена дольше 10 минут: деньги в подвешенном состоянии.
  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'stuck_submit:' || a.id AS key, t.amount, t.currency, m.name, a.error
       FROM transaction_attempts a JOIN transactions t ON t.id = a.transaction_id JOIN merchant_accounts m ON m.id = a.merchant_account_id
       WHERE a.status = 'pending' AND a.submitted_at < now() - interval '10 minutes' AND a.provider_ref IS NULL
         AND a.submit_outcome IS DISTINCT FROM 'declined' AND a.submitted_at > now() - interval '7 days') k
     WHERE ${sent} LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `⏳ Платёж ${money(r.amount, r.currency)} висит: ответ провайдера на создание потерян (аккаунт «${r.name}»). Без каскада, пока не выяснится, создан ли платёж.
${boardUrl}#stuck` });
  }

  // Вебхук провайдера не обработан дольше 10 минут.
  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'stuck_inbox:' || e.id AS key, m.name, e.attempts, e.last_error
       FROM provider_webhook_events e JOIN merchant_accounts m ON m.id = e.merchant_account_id
       WHERE e.processed_at IS NULL AND e.received_at < now() - interval '10 minutes' AND e.received_at > now() - interval '7 days') k
     WHERE ${sent} LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `📨 Вебхук провайдера (аккаунт «${r.name}») не удаётся обработать: ${r.attempts} попыток, ${String(r.last_error ?? '').slice(0, 150)}.
${boardUrl}#stuck` });
  }
  return out;
}

/** Один проход: собрать и отправить новое. Возвращает, сколько отправлено. */
export async function notifyOnce(pool: Pool, sender: Sender, boardUrl: string, channel = 'telegram'): Promise<number> {
  let n = 0;
  for (const a of await collectAlerts(pool, boardUrl)) {
    await sender.send(a.text); // не отправилось — ключ не ставим, попробуем на следующем проходе
    await pool.query(`INSERT INTO notifications_sent (key, channel) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a.key, channel]);
    n++;
  }
  return n;
}
