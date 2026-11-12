import type { Client } from '../db/tx.js';

/*
 * Ограничения игрока (ответственная игра). Правила:
 *  - Самоисключение «залипает». Депозит может только ВКЛЮЧИТЬ его (selfExcluded: true).
 *    Отсутствие поля или false в депозите ничего не снимает. Снять можно только через
 *    PUT /v1/players/:id/restrictions — с записью в журнал.
 *  - Дневной лимит депозитов. Снижение (или установка, если лимита не было) действует сразу — и из депозита,
 *    и из API. Повышение и снятие — только через API и только после периода охлаждения оператора
 *    (по умолчанию 24 ч): до этого действует прежний, более строгий лимит.
 *  - KYC меняется, только если сайт явно прислал значение.
 * Каждое изменение пишется в player_restriction_events; restrictions_version растёт —
 * так API может отклонить запрос, построенный на устаревшем состоянии.
 */

export type KycStatus = 'none' | 'pending' | 'verified' | 'rejected';
export type RestrictionSource = 'deposit' | 'payout' | 'api' | 'system';

export interface PlayerRow {
  id: string;
  site_id: string;
  external_id: string;
  country: string;
  kyc: KycStatus;
  deposit_limit_daily: bigint | null;
  self_excluded: boolean;
  self_excluded_at: Date | null;
  deposit_limit_pending_set: boolean;
  deposit_limit_pending: bigint | null;
  deposit_limit_pending_at: Date | null;
  restrictions_version: number;
  sticky_account_id: string | null;
}

export interface RestrictionChange {
  selfExcluded?: boolean;
  kyc?: KycStatus;
  /** null — снять лимит. */
  depositLimitDaily?: bigint | null;
}

const show = (v: unknown) => (v === null || v === undefined ? null : String(v));

async function event(c: Client, playerId: string, field: string, oldV: unknown, newV: unknown, source: RestrictionSource, note?: string) {
  await c.query(
    `INSERT INTO player_restriction_events (player_id, field, old_value, new_value, source, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [playerId, field, show(oldV), show(newV), source, note ?? null]);
}

/** Строка игрока под блокировкой (вызывать внутри транзакции). */
export async function lockPlayer(c: Client, playerId: string): Promise<PlayerRow> {
  return (await c.query(`SELECT * FROM players WHERE id = $1 FOR UPDATE`, [playerId])).rows[0];
}

/**
 * Применить изменения ограничений. Из депозита (source = 'deposit') разрешено только ужесточение:
 * включить самоисключение, снизить/установить лимит, сообщить KYC. Возвращает актуальную строку.
 */
export async function applyRestrictions(
  c: Client, player: PlayerRow, change: RestrictionChange, source: RestrictionSource,
  opts: { increaseDelayHours: number; note?: string },
): Promise<PlayerRow> {
  let p = await applyDuePending(c, player);
  const sets: string[] = [];
  const args: unknown[] = [p.id];
  const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };

  if (change.selfExcluded === true && !p.self_excluded) {
    set('self_excluded', true); set('self_excluded_at', new Date());
    await event(c, p.id, 'self_excluded', false, true, source, opts.note);
  } else if (change.selfExcluded === false && p.self_excluded && source === 'api') {
    set('self_excluded', false); set('self_excluded_at', null);
    await event(c, p.id, 'self_excluded', true, false, source, opts.note);
  }

  if (change.kyc !== undefined && change.kyc !== p.kyc) {
    set('kyc', change.kyc);
    await event(c, p.id, 'kyc', p.kyc, change.kyc, source, opts.note);
  }

  if (change.depositLimitDaily !== undefined) {
    const cur = p.deposit_limit_daily;
    const next = change.depositLimitDaily;
    const stricter = next !== null && (cur === null || next < cur);
    if (stricter) {
      set('deposit_limit_daily', next);
      // Ожидающее повышение отменяется: игрок только что попросил лимит строже.
      if (p.deposit_limit_pending_set) {
        set('deposit_limit_pending_set', false); set('deposit_limit_pending', null); set('deposit_limit_pending_at', null);
      }
      await event(c, p.id, 'deposit_limit_daily', cur, next, source, opts.note);
    } else if (next !== cur && source === 'api') {
      // Повышение или снятие — только после охлаждения.
      const at = new Date(Date.now() + opts.increaseDelayHours * 3600_000);
      if (opts.increaseDelayHours === 0) {
        set('deposit_limit_daily', next);
        await event(c, p.id, 'deposit_limit_daily', cur, next, source, opts.note);
      } else {
        set('deposit_limit_pending_set', true); set('deposit_limit_pending', next); set('deposit_limit_pending_at', at);
        await event(c, p.id, 'deposit_limit_pending', cur, next, source, `вступит в силу ${at.toISOString()}${opts.note ? ` · ${opts.note}` : ''}`);
      }
    }
  }

  if (sets.length) {
    p = (await c.query(
      `UPDATE players SET ${sets.join(', ')}, restrictions_version = restrictions_version + 1, updated_at = now()
       WHERE id = $1 RETURNING *`, args)).rows[0];
  }
  return p;
}

/** Ожидающее повышение лимита вступает в силу, когда прошёл период охлаждения. */
export async function applyDuePending(c: Client, p: PlayerRow): Promise<PlayerRow> {
  if (!p.deposit_limit_pending_set || !p.deposit_limit_pending_at || p.deposit_limit_pending_at > new Date()) return p;
  await event(c, p.id, 'deposit_limit_daily', p.deposit_limit_daily, p.deposit_limit_pending, 'system', 'период охлаждения прошёл');
  return (await c.query(
    `UPDATE players SET deposit_limit_daily = deposit_limit_pending, deposit_limit_pending_set = false,
       deposit_limit_pending = NULL, deposit_limit_pending_at = NULL, restrictions_version = restrictions_version + 1, updated_at = now()
     WHERE id = $1 RETURNING *`, [p.id])).rows[0];
}

export function serializeRestrictions(p: PlayerRow) {
  return {
    playerId: p.external_id,
    selfExcluded: p.self_excluded,
    selfExcludedAt: p.self_excluded_at?.toISOString() ?? null,
    kyc: p.kyc,
    depositLimitDaily: p.deposit_limit_daily?.toString() ?? null,
    pendingDepositLimit: p.deposit_limit_pending_set
      ? { value: p.deposit_limit_pending?.toString() ?? null, effectiveAt: p.deposit_limit_pending_at!.toISOString() } : null,
    version: p.restrictions_version,
  };
}
