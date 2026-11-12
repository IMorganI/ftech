import { createHash } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { withTransaction, isUniqueViolation, type Client } from '../db/tx.js';
import { enqueueSiteEvent } from '../webhooks/outbox.js';
import { applyRestrictions, type KycStatus } from '../players/restrictions.js';

/*
 * Роутер депозитов.
 *
 * Порядок решений:
 *   1. Проверки игрока (самоисключение, KYC, его дневной лимит, лицензия страны).
 *      Не прошёл — платёж ОТКЛОНЯЕТСЯ. Лимит игрока никогда не обходится через другой аккаунт.
 *   2. Отбор аккаунтов оператора по валюте, стране и сумме.
 *   3. Блокировка строк оборота кандидатов (по возрастанию id — без взаимных блокировок)
 *      и проверка свободного лимита с учётом порога переключения (по умолчанию 95%).
 *   4. Выбор: «липкий» аккаунт игрока → приоритет → комиссия → больше свободного лимита.
 *   5. Резерв суммы на выбранном аккаунте. Платёж в статусе pending.
 *
 * Результат попытки (успех/отказ провайдера) применяется в resolveAttempt():
 * успех превращает резерв в оборот и пишет проводки, отказ снимает резерв и пробует следующий аккаунт.
 */

export type { KycStatus };

export interface DepositRequest {
  siteId: string;
  operatorId: string;
  idempotencyKey: string;
  amount: bigint;
  currency: string;
  returnUrl?: string | null;
  player: {
    externalId: string;
    country: string;
    /** Необязательные подсказки сайта. Из депозита ограничения можно только ужесточить (см. players/restrictions.ts). */
    kyc?: KycStatus;
    depositLimitDaily?: bigint | null;
    selfExcluded?: boolean;
  };
}

export type DeclineCode =
  | 'player_self_excluded'
  | 'kyc_rejected'
  | 'kyc_required'
  | 'player_limit_exceeded'
  | 'country_not_licensed'
  | 'no_route'
  | 'all_attempts_failed'
  | 'provider_unavailable';

export interface TransactionView {
  id: string;
  siteId: string;
  playerId: string;
  type: 'deposit' | 'payout';
  amount: bigint;
  currency: string;
  status: 'created' | 'pending' | 'success' | 'declined' | 'failed';
  merchantAccountId: string | null;
  declineCode: string | null;
  /** Для выплат: ID вывода в системе казино. */
  withdrawalId?: string | null;
  /** Куда отправить игрока для оплаты (страница провайдера), пока платёж ожидает оплаты. */
  paymentUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Этот Idempotency-Key уже использован с другими параметрами');
  }
}

interface Candidate {
  id: string;
  name: string;
  priority: number;
  fee_bps: number;
  daily_cap: bigint;
  monthly_cap: bigint | null;
  switch_at_bps: number;
  today: string; // дата в часовом поясе аккаунта, YYYY-MM-DD
}

interface Pick {
  account: Candidate;
  day: string;
  currency: string;
  reason: string;
}

const TX_COLUMNS = `id, site_id, player_id, type, amount, currency, status, merchant_account_id, decline_code, withdrawal_id, created_at, updated_at`;

function toView(r: Record<string, any>): TransactionView {
  return {
    id: r.id, siteId: r.site_id, playerId: r.player_id, type: r.type, amount: r.amount, currency: r.currency,
    status: r.status, merchantAccountId: r.merchant_account_id, declineCode: r.decline_code, withdrawalId: r.withdrawal_id ?? null,
    paymentUrl: r.payment_url ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function requestHash(req: DepositRequest): string {
  const p = req.player;
  return createHash('sha256')
    .update(JSON.stringify([req.amount.toString(), req.currency, p.externalId, p.country]))
    .digest('hex');
}

/** Создаёт депозит и выбирает для него мерчант-аккаунт. Повтор с тем же ключом возвращает тот же платёж. */
export async function routeDeposit(pool: Pool, req: DepositRequest): Promise<{ tx: TransactionView; replayed: boolean }> {
  const hash = requestHash(req);
  try {
    return await withTransaction(pool, async (c) => {
      const existing = await findByIdempotencyKey(c, req.siteId, req.idempotencyKey);
      if (existing) return replay(existing, hash);
      return { tx: await createDeposit(c, req, hash), replayed: false };
    });
  } catch (err) {
    // Два одинаковых запроса пришли одновременно: второй упёрся в уникальный ключ — отдаём первый.
    if (isUniqueViolation(err, 'transactions_site_id_idempotency_key_key')) {
      const c = await pool.connect();
      try {
        const existing = await findByIdempotencyKey(c, req.siteId, req.idempotencyKey);
        if (existing) return replay(existing, hash);
      } finally {
        c.release();
      }
    }
    throw err;
  }
}

function replay(row: Record<string, any>, hash: string) {
  if (row.request_hash !== hash) throw new IdempotencyConflictError();
  return { tx: toView(row), replayed: true };
}

async function findByIdempotencyKey(c: Client, siteId: string, key: string) {
  const r = await c.query(`SELECT ${TX_COLUMNS}, request_hash FROM transactions WHERE site_id = $1 AND idempotency_key = $2`, [siteId, key]);
  return r.rows[0] as Record<string, any> | undefined;
}

async function createDeposit(c: Client, req: DepositRequest, hash: string): Promise<TransactionView> {
  const p = req.player;
  // Upsert игрока сразу блокирует его строку: параллельные депозиты одного игрока идут по очереди,
  // поэтому его дневной лимит нельзя обойти двумя одновременными запросами.
  // Ограничения из запроса НЕ перезаписывают сохранённые: применяются только ужесточения.
  const inserted = (await c.query(
    `INSERT INTO players (site_id, external_id, country) VALUES ($1, $2, $3)
     ON CONFLICT (site_id, external_id) DO UPDATE SET country = EXCLUDED.country, updated_at = now()
     RETURNING *`,
    [req.siteId, p.externalId, p.country],
  )).rows[0];
  const delay = (await c.query(`SELECT limit_increase_delay_hours FROM operators WHERE id = $1`, [req.operatorId])).rows[0].limit_increase_delay_hours;
  const player = await applyRestrictions(c, inserted, {
    selfExcluded: p.selfExcluded, kyc: p.kyc,
    // null в депозите не снимает лимит — снятие только через API ограничений.
    depositLimitDaily: p.depositLimitDaily === null ? undefined : p.depositLimitDaily,
  }, 'deposit', { increaseDelayHours: delay });

  const op = (await c.query(
    `SELECT licenses, kyc_required_above, max_attempts FROM operators WHERE id = $1`, [req.operatorId],
  )).rows[0];

  const insertTx = async (status: 'pending' | 'declined', accountId: string | null, decline: DeclineCode | null) =>
    toView((await c.query(
      `INSERT INTO transactions (site_id, player_id, type, amount, currency, status, merchant_account_id, decline_code, idempotency_key, request_hash, return_url)
       VALUES ($1, $2, 'deposit', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${TX_COLUMNS}`,
      [req.siteId, player.id, req.amount, req.currency, status, accountId, decline, req.idempotencyKey, hash, req.returnUrl ?? null],
    )).rows[0]);

  // 1. Проверки игрока
  const decline = await playerDecline(c, req, player, op);
  if (decline) return insertTx('declined', null, decline);

  // 2–4. Выбор аккаунта
  const pick = await pickAccount(c, {
    operatorId: req.operatorId, currency: req.currency, country: p.country, amount: req.amount,
    stickyAccountId: player.sticky_account_id, exclude: [],
  });
  if (!pick) return insertTx('declined', null, 'no_route');

  // 5. Резерв и попытка
  await reserve(c, pick, req.amount);
  const tx = await insertTx('pending', pick.account.id, null);
  await insertAttempt(c, tx.id, pick, 1);
  return tx;
}

async function playerDecline(
  c: Client, req: DepositRequest, player: { id: string; self_excluded: boolean; kyc: KycStatus; deposit_limit_daily: bigint | null },
  op: { licenses: string[]; kyc_required_above: bigint | null },
): Promise<DeclineCode | null> {
  // Решения принимаются по СОХРАНЁННЫМ ограничениям игрока, а не по тому, что прислал запрос.
  if (player.self_excluded) return 'player_self_excluded';
  if (!op.licenses.map((l) => l.trim()).includes(req.player.country)) return 'country_not_licensed';
  if (player.kyc === 'rejected') return 'kyc_rejected';
  if (player.kyc !== 'verified' && op.kyc_required_above !== null && req.amount > op.kyc_required_above) return 'kyc_required';
  if (player.deposit_limit_daily !== null) {
    // Лимит игрока — в валюте депозита: суммы разных валют не складываются.
    const today = (await c.query(
      `SELECT coalesce(sum(amount), 0)::bigint AS total FROM transactions
       WHERE player_id = $1 AND type = 'deposit' AND currency = $2 AND status IN ('pending', 'success')
         AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [player.id, req.currency],
    )).rows[0].total as bigint;
    if (today + req.amount > player.deposit_limit_daily) return 'player_limit_exceeded';
  }
  return null;
}

interface PickInput {
  operatorId: string;
  currency: string;
  country: string;
  amount: bigint;
  stickyAccountId: string | null;
  exclude: string[];
}

async function pickAccount(c: Client, inp: PickInput): Promise<Pick | null> {
  const cands = (await c.query<Candidate>(
    `SELECT id, name, priority, fee_bps, daily_cap, monthly_cap, switch_at_bps,
            to_char((now() AT TIME ZONE cap_timezone)::date, 'YYYY-MM-DD') AS today
     FROM merchant_accounts
     WHERE operator_id = $1 AND enabled
       AND $2::char(3) = ANY(currencies) AND $3::char(2) = ANY(countries)
       AND $4::bigint BETWEEN min_amount AND max_amount
       AND NOT (id = ANY($5::uuid[]))
     ORDER BY id`,
    [inp.operatorId, inp.currency, inp.country, inp.amount, inp.exclude],
  )).rows;
  if (!cands.length) return null;

  // Строки оборота на сегодня: создаём, если их нет, и блокируем в порядке id.
  // Оборот считается в валюте платежа: разные валюты не складываются.
  await c.query(
    `INSERT INTO account_usage (merchant_account_id, day, currency)
     SELECT k.id, k.day, $3 FROM unnest($1::uuid[], $2::date[]) AS k(id, day) ON CONFLICT DO NOTHING`,
    [cands.map((a) => a.id), cands.map((a) => a.today), inp.currency],
  );
  const usage = new Map<string, { used: bigint; reserved: bigint }>();
  for (const r of (await c.query(
    `SELECT u.merchant_account_id AS id, u.used, u.reserved
     FROM account_usage u JOIN unnest($1::uuid[], $2::date[]) AS k(id, day)
       ON u.merchant_account_id = k.id AND u.day = k.day AND u.currency = $3
     ORDER BY u.merchant_account_id FOR UPDATE OF u`,
    [cands.map((a) => a.id), cands.map((a) => a.today), inp.currency],
  )).rows) usage.set(r.id, { used: r.used, reserved: r.reserved });

  const monthly = new Map<string, bigint>();
  for (const r of (await c.query(
    `SELECT u.merchant_account_id AS id, sum(u.used + u.reserved)::bigint AS total
     FROM account_usage u JOIN unnest($1::uuid[], $2::date[]) AS k(id, day)
       ON u.merchant_account_id = k.id AND u.day >= date_trunc('month', k.day) AND u.day <= k.day AND u.currency = $3
     GROUP BY u.merchant_account_id`,
    [cands.map((a) => a.id), cands.map((a) => a.today), inp.currency],
  )).rows) monthly.set(r.id, r.total);

  const skipped: string[] = [];
  const fitting: { a: Candidate; free: bigint }[] = [];
  for (const a of cands) {
    const u = usage.get(a.id)!;
    const dailyLimit = (a.daily_cap * BigInt(a.switch_at_bps)) / 10000n;
    const free = dailyLimit - u.used - u.reserved;
    if (free < inp.amount) { skipped.push(`${a.name}: дневной лимит`); continue; }
    if (a.monthly_cap !== null) {
      const monthLimit = (a.monthly_cap * BigInt(a.switch_at_bps)) / 10000n;
      if ((monthly.get(a.id) ?? 0n) + inp.amount > monthLimit) { skipped.push(`${a.name}: месячный лимит`); continue; }
    }
    fitting.push({ a, free });
  }
  if (!fitting.length) return null;

  fitting.sort((x, y) =>
    Number(y.a.id === inp.stickyAccountId) - Number(x.a.id === inp.stickyAccountId) ||
    y.a.priority - x.a.priority ||
    x.a.fee_bps - y.a.fee_bps ||
    (y.free > x.free ? 1 : y.free < x.free ? -1 : 0));

  const best = fitting[0]!.a;
  let reason = best.id === inp.stickyAccountId ? 'липкость к прошлому аккаунту игрока'
    : `лучший по приоритету и комиссии (${best.fee_bps / 100}%)`;
  if (inp.stickyAccountId && best.id !== inp.stickyAccountId) reason += '; прошлый аккаунт игрока недоступен';
  if (skipped.length) reason += `; пропущены: ${skipped.join(', ')}`;
  if (inp.exclude.length) reason += `; каскад после ${inp.exclude.length} отказа(ов)`;
  return { account: best, day: best.today, currency: inp.currency, reason };
}

async function reserve(c: Client, pick: Pick, amount: bigint) {
  await c.query(
    `UPDATE account_usage SET reserved = reserved + $3 WHERE merchant_account_id = $1 AND day = $2 AND currency = $4`,
    [pick.account.id, pick.day, amount, pick.currency],
  );
}

async function insertAttempt(c: Client, txId: string, pick: Pick, no: number) {
  await c.query(
    `INSERT INTO transaction_attempts (transaction_id, merchant_account_id, status, route_reason, attempt_no, usage_day)
     VALUES ($1, $2, 'pending', $3, $4, $5)`,
    [txId, pick.account.id, pick.reason, no, pick.day],
  );
}

export type AttemptOutcome =
  | { status: 'success'; providerRef?: string; attemptId?: string }
  | { status: 'declined'; providerRef?: string; error?: string; attemptId?: string;
      /** Без каскада: платёж закрывается отказом с этим кодом (например, судьба прошлой отправки неизвестна). */
      final?: DeclineCode };

/**
 * Применяет результат текущей попытки. Повторный вызов для уже завершённого платежа ничего не меняет
 * (провайдеры часто присылают один вебхук несколько раз).
 */
export async function resolveAttempt(pool: Pool, txId: string, outcome: AttemptOutcome): Promise<TransactionView> {
  return withTransaction(pool, async (c) => {
    const tx = (await c.query(
      `SELECT ${TX_COLUMNS} FROM transactions WHERE id = $1 FOR UPDATE`, [txId],
    )).rows[0];
    if (!tx) throw new Error(`Платёж ${txId} не найден`);
    if (tx.status !== 'pending') return toView(tx);

    const attempt = (await c.query(
      `SELECT id, merchant_account_id, usage_day, attempt_no FROM transaction_attempts
       WHERE transaction_id = $1 AND status = 'pending' ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`, [txId],
    )).rows[0];
    if (!attempt) throw new Error(`У платежа ${txId} нет активной попытки`);
    // Результат относится к старой попытке (каскад уже ушёл дальше) — текущую не трогаем.
    if (outcome.attemptId && outcome.attemptId !== attempt.id) return toView(tx);

    const amount = tx.amount as bigint;
    const usageArgs = [attempt.merchant_account_id, attempt.usage_day, amount, (tx.currency as string).trim()];

    if (outcome.status === 'success') {
      await c.query(
        `UPDATE account_usage SET reserved = reserved - $3, used = used + $3 WHERE merchant_account_id = $1 AND day = $2 AND currency = $4`, usageArgs);
      await c.query(`UPDATE transaction_attempts SET status = 'success', provider_ref = coalesce($2, provider_ref) WHERE id = $1`,
        [attempt.id, outcome.providerRef ?? null]);
      await c.query(`UPDATE players SET sticky_account_id = $2, updated_at = now() WHERE id = $1`,
        [tx.player_id, attempt.merchant_account_id]);
      // Двойная запись: деньги пришли на мерчант-аккаунт (+), выросло обязательство перед игроком (−).
      await c.query(
        `INSERT INTO ledger_entries (transaction_id, account, amount, currency) VALUES
           ($1, 'merchant:' || $2, $3, $4), ($1, 'player:' || $5, -$3::bigint, $4)`,
        [txId, attempt.merchant_account_id, amount, tx.currency, tx.player_id]);
      // Снимок комиссий: заработок платформы и расход на провайдера (округление вниз до цента).
      const done = toView((await c.query(
        `UPDATE transactions t SET status = 'success', updated_at = now(),
           platform_fee = t.amount * o.platform_fee_bps / 10000,
           provider_fee = t.amount * m.fee_bps / 10000
         FROM sites s, operators o, merchant_accounts m
         WHERE t.id = $1 AND s.id = t.site_id AND o.id = s.operator_id AND m.id = $2
         RETURNING ${TX_COLUMNS.split(', ').map((col) => 't.' + col).join(', ')}`, [txId, attempt.merchant_account_id])).rows[0]);
      await enqueueSiteEvent(c, done, 'deposit.succeeded');
      return done;
    }

    // Отказ провайдера: снимаем резерв и пробуем следующий аккаунт (каскад).
    await c.query(`UPDATE account_usage SET reserved = reserved - $3 WHERE merchant_account_id = $1 AND day = $2 AND currency = $4`, usageArgs);
    await c.query(`UPDATE transaction_attempts SET status = 'declined', provider_ref = coalesce($2, provider_ref), error = $3 WHERE id = $1`,
      [attempt.id, outcome.providerRef ?? null, outcome.error ?? null]);

    const ctx = (await c.query(
      `SELECT p.country, p.sticky_account_id, s.operator_id, o.max_attempts,
              array_agg(a.merchant_account_id) AS tried
       FROM transactions t JOIN players p ON p.id = t.player_id JOIN sites s ON s.id = t.site_id
       JOIN operators o ON o.id = s.operator_id JOIN transaction_attempts a ON a.transaction_id = t.id
       WHERE t.id = $1 GROUP BY p.country, p.sticky_account_id, s.operator_id, o.max_attempts`, [txId],
    )).rows[0];

    const next = !outcome.final && attempt.attempt_no < ctx.max_attempts
      ? await pickAccount(c, {
          operatorId: ctx.operator_id, currency: tx.currency.trim(), country: ctx.country.trim(), amount,
          stickyAccountId: ctx.sticky_account_id, exclude: ctx.tried,
        })
      : null;

    if (!next) {
      const done = toView((await c.query(
        `UPDATE transactions SET status = 'declined', decline_code = $2, merchant_account_id = NULL,
           updated_at = now() WHERE id = $1 RETURNING ${TX_COLUMNS}`,
        [txId, outcome.status === 'declined' && outcome.final ? outcome.final : 'all_attempts_failed'])).rows[0]);
      await enqueueSiteEvent(c, done, 'deposit.declined');
      return done;
    }
    await reserve(c, next, amount);
    await insertAttempt(c, txId, next, attempt.attempt_no + 1);
    return toView((await c.query(
      `UPDATE transactions SET merchant_account_id = $2, updated_at = now() WHERE id = $1 RETURNING ${TX_COLUMNS}`,
      [txId, next.account.id])).rows[0]);
  });
}

const PAYMENT_URL = `(SELECT a.redirect_url FROM transaction_attempts a
  WHERE a.transaction_id = transactions.id AND a.status = 'pending' ORDER BY a.attempt_no DESC LIMIT 1) AS payment_url`;

export async function getTransaction(pool: Pool | Client, siteId: string, id: string): Promise<TransactionView | null> {
  const r = await pool.query(`SELECT ${TX_COLUMNS}, ${PAYMENT_URL} FROM transactions WHERE id = $1 AND site_id = $2`, [id, siteId]);
  return r.rows[0] ? toView(r.rows[0]) : null;
}

export async function getTransactionById(pool: Pool | Client, id: string): Promise<TransactionView | null> {
  const r = await pool.query(`SELECT ${TX_COLUMNS}, ${PAYMENT_URL} FROM transactions WHERE id = $1`, [id]);
  return r.rows[0] ? toView(r.rows[0]) : null;
}

/** Публичное представление платежа для сайта (без внутренних деталей роутинга). */
export function serializeTx(tx: TransactionView) {
  return {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    amount: tx.amount.toString(),
    currency: tx.currency,
    declineCode: tx.declineCode,
    paymentUrl: tx.status === 'pending' ? tx.paymentUrl : null,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
  };
}
