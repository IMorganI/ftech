// Тесты схемы. Нужна реальная PostgreSQL: задай TEST_DATABASE_URL (в CI задаётся автоматически).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('База данных', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await pool?.end(); });

  async function seed() {
    const op = (await pool.query(`INSERT INTO operators (name, licenses) VALUES ('Op', '{MT}') RETURNING id`)).rows[0].id;
    const site = (await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'Site', md5(random()::text)) RETURNING id`, [op])).rows[0].id;
    const prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock-' || md5(random()::text), 'Mock', 'mock') RETURNING id`)).rows[0].id;
    const acc = (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap)
       VALUES ($1, $2, 'A', '{EUR}', '{MT}', 1000, 200000, 600000) RETURNING id`, [op, prov])).rows[0].id;
    const player = (await pool.query(`INSERT INTO players (site_id, external_id, country) VALUES ($1, md5(random()::text), 'MT') RETURNING id`, [site])).rows[0].id;
    return { op, site, prov, acc, player };
  }

  it('повторный запуск миграций ничего не применяет', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('суммы читаются как bigint без потери точности', async () => {
    const r = await pool.query(`SELECT 9007199254740993::bigint AS v`);
    expect(r.rows[0].v).toBe(9007199254740993n);
  });

  it('один ключ идемпотентности не создаёт два платежа', async () => {
    const { site, player } = await seed();
    const ins = `INSERT INTO transactions (site_id, player_id, type, amount, currency, idempotency_key)
                 VALUES ($1, $2, 'deposit', 5000, 'EUR', 'key-1')`;
    await pool.query(ins, [site, player]);
    await expect(pool.query(ins, [site, player])).rejects.toThrow(/duplicate key/);
  });

  it('записи журнала нельзя изменить или удалить', async () => {
    const { site, player } = await seed();
    const tx = (await pool.query(
      `INSERT INTO transactions (site_id, player_id, type, amount, currency, idempotency_key)
       VALUES ($1, $2, 'deposit', 5000, 'EUR', 'key-ledger') RETURNING id`, [site, player])).rows[0].id;
    const e = (await pool.query(`INSERT INTO ledger_entries (transaction_id, account, amount, currency) VALUES ($1, 'x', 5000, 'EUR') RETURNING id`, [tx])).rows[0].id;
    await expect(pool.query(`UPDATE ledger_entries SET amount = 1 WHERE id = $1`, [e])).rejects.toThrow(/нельзя/);
    await expect(pool.query(`DELETE FROM ledger_entries WHERE id = $1`, [e])).rejects.toThrow(/нельзя/);
  });

  it('отрицательный оборот аккаунта запрещён', async () => {
    const { acc } = await seed();
    await expect(pool.query(`INSERT INTO account_usage (merchant_account_id, day, used) VALUES ($1, current_date, -1)`, [acc]))
      .rejects.toThrow(/check constraint/);
  });

  it('аккаунт с max < min не создаётся', async () => {
    const { op, prov } = await seed();
    await expect(pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap)
       VALUES ($1, $2, 'bad', '{EUR}', '{MT}', 5000, 100, 1000)`, [op, prov])).rejects.toThrow(/check constraint/);
  });
});
