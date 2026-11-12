import type { Pool } from '../db/pool.js';
import type { Sender } from './telegram.js';
import { capacity } from '../admin/capacity.js';

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
  // Общая ёмкость по валюте: 70% и 90% дневных лимитов всех включённых аккаунтов — раз в сутки на порог.
  const day = new Date().toISOString().slice(0, 10);
  for (const c of (await capacity(pool)).currencies) {
    for (const level of [70, 90]) {
      if (c.fillPct < level) continue;
      const key = `capacity:${c.currency}:${level}:${day}`;
      if ((await pool.query(`SELECT 1 FROM notifications_sent WHERE key = $1`, [key])).rows[0]) continue;
      const eta = c.exhaustInMin !== null && c.exhaustInMin < c.resetInMin
        ? ` При текущем темпе (${money(c.ratePerHour, c.currency)}/ч) лимиты закончатся примерно через ${c.exhaustInMin < 60 ? `${c.exhaustInMin} мин` : `${Math.round(c.exhaustInMin / 60)} ч`}.` : '';
      out.push({ key, text: `${level >= 90 ? '🔴' : '🟠'} Занято ${c.fillPct}% дневных лимитов в ${c.currency}: свободно ${money(c.free, c.currency)}.${eta} Подключи или включи аккаунт, подними лимит у провайдера.
${boardUrl}#accounts` });
    }
  }

  // Новый чарджбэк и приближающийся срок ответа.
  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'chargeback:' || cb.id AS key, cb.amount, cb.currency, cb.reason_code, cb.respond_by, m.name, p.external_id AS player
       FROM chargebacks cb JOIN merchant_accounts m ON m.id = cb.merchant_account_id JOIN transactions t ON t.id = cb.transaction_id
       JOIN players p ON p.id = t.player_id WHERE cb.opened_at > now() - interval '7 days') k
     WHERE ${sent} LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `💳 Чарджбэк ${money(r.amount, r.currency)}: игрок ${r.player}, аккаунт «${r.name}»${r.reason_code ? `, код ${r.reason_code}` : ''}${r.respond_by ? `. Ответить до ${new Date(r.respond_by).toLocaleDateString('ru-RU')}` : ''}.
${boardUrl}#chargebacks` });
  }
  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'cb_deadline:' || cb.id AS key, cb.amount, cb.currency, cb.respond_by
       FROM chargebacks cb WHERE cb.status = 'open' AND cb.respond_by IS NOT NULL
         AND cb.respond_by <= (now() AT TIME ZONE 'UTC')::date + 2) k
     WHERE ${sent} LIMIT 20`)).rows) {
    out.push({ key: r.key, text: `⏰ Срок ответа по чарджбэку ${money(r.amount, r.currency)} — ${new Date(r.respond_by).toLocaleDateString('ru-RU')}. Не ответишь — спор проигран.
${boardUrl}#chargebacks` });
  }
  // Выписка провайдера с серьёзными расхождениями.
  for (const r of (await pool.query(
    `SELECT * FROM (SELECT 'report:' || r.id AS key, r.filename, m.name, (r.summary->>'bad')::int AS bad
       FROM report_imports r JOIN merchant_accounts m ON m.id = r.merchant_account_id
       WHERE (r.summary->>'bad')::int > 0 AND r.uploaded_at > now() - interval '7 days') k
     WHERE ${sent} LIMIT 10`)).rows) {
    out.push({ key: r.key, text: `🧾 Сверка «${r.filename}» (аккаунт «${r.name}»): ${r.bad} серьёзн. расхождени(е/й) с провайдером.
${boardUrl}#reconciliation` });
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
