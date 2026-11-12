// Уведомления о проблемах: что попадает в Telegram, и что одно событие не отправляется дважды.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { notifyOnce } from '../src/notify/alerts.js';
import { TelegramSender, type TgFetch } from '../src/notify/telegram.js';

const url = process.env.TEST_DATABASE_URL;

describe('Telegram', () => {
  it('отправляет в нужный чат, токен только в адресе', async () => {
    const calls: { url: string; body: string }[] = [];
    const f: TgFetch = async (u, init) => { calls.push({ url: u, body: init.body }); return { ok: true, status: 200, text: async () => '{}' }; };
    await new TelegramSender('123:ABC', '777', f).send('тест');
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: '777', text: 'тест' });
  });
  it('ошибка Telegram не раскрывает токен', async () => {
    const f: TgFetch = async () => ({ ok: false, status: 401, text: async () => '{"description":"Unauthorized"}' });
    const err = await new TelegramSender('123:SECRET', '777', f).send('x').catch((e: Error) => e);
    expect(String(err)).toMatch(/401/);
    expect(String(err)).not.toContain('SECRET');
  });
});

describe.skipIf(!url)('Уведомления о проблемах', () => {
  let pool: Pool;
  let acc: string;
  let tx: string;
  const board = 'https://demo.test/admin';

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
  });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE notifications_sent, reconciliation_issues, webhook_deliveries, transaction_attempts, transactions,
      account_usage, players, merchant_accounts, sites, providers, operators CASCADE`);
    const op = (await pool.query(`INSERT INTO operators (name, licenses) VALUES ('Op', '{MT}') RETURNING id`)).rows[0].id;
    const site = (await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash, webhook_url) VALUES ($1, 'casino', 'h', 'https://x') RETURNING id`, [op])).rows[0].id;
    const prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('viva', 'Viva', 'viva') RETURNING id`)).rows[0].id;
    acc = (await pool.query(`INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap)
      VALUES ($1, $2, 'Viva demo', '{EUR}', '{MT}', 100, 100000, 100000) RETURNING id`, [op, prov])).rows[0].id;
    const player = (await pool.query(`INSERT INTO players (site_id, external_id, country) VALUES ($1, 'p', 'MT') RETURNING id`, [site])).rows[0].id;
    tx = (await pool.query(`INSERT INTO transactions (site_id, player_id, type, amount, currency, status, idempotency_key)
      VALUES ($1, $2, 'deposit', 5000, 'EUR', 'pending', 'k-notify-1') RETURNING id`, [site, player])).rows[0].id;
    await pool.query(`INSERT INTO reconciliation_issues (transaction_id, kind, details) VALUES ($1, 'late_success', 'У нас declined, у провайдера success')`, [tx]);
    await pool.query(`INSERT INTO webhook_deliveries (site_id, transaction_id, event, payload, status, last_error) VALUES ($1, $2, 'deposit.succeeded', '{}', 'failed', 'HTTP 500')`, [site, tx]);
    await pool.query(`INSERT INTO account_usage (merchant_account_id, day, currency, used) VALUES ($1, current_date, 'EUR', 96000)`, [acc]);
    await pool.query(`INSERT INTO transaction_attempts (transaction_id, merchant_account_id, status, route_reason, error) VALUES ($1, $2, 'pending', 'r', 'submit_error: ETIMEDOUT')`, [tx, acc]);
  });

  const collector = () => {
    const sent: string[] = [];
    return { sent, sender: { send: async (t: string) => { sent.push(t); } } };
  };

  it('сообщает о расхождении, недоставленном вебхуке, лимите аккаунта и недоступном провайдере', async () => {
    const { sent, sender } = collector();
    expect(await notifyOnce(pool, sender, board)).toBe(4);
    expect(sent.join('\n---\n')).toMatch(/закрыли[\s\S]*#issues/);
    expect(sent.some((t) => t.includes('casino') && t.includes('HTTP 500'))).toBe(true);
    expect(sent.some((t) => t.includes('Viva demo') && t.includes('95%') && t.includes('960.00'))).toBe(true);
    expect(sent.some((t) => t.includes('не отвечает') && t.includes('ETIMEDOUT'))).toBe(true);
  });

  it('одно и то же событие не отправляется дважды', async () => {
    const { sent, sender } = collector();
    await notifyOnce(pool, sender, board);
    expect(await notifyOnce(pool, sender, board)).toBe(0);
    expect(sent).toHaveLength(4);
  });

  it('если Telegram недоступен — отправит на следующем проходе', async () => {
    let fail = true;
    const sent: string[] = [];
    const flaky = { send: async (t: string) => { if (fail) throw new Error('network'); sent.push(t); } };
    await expect(notifyOnce(pool, flaky, board)).rejects.toThrow('network');
    fail = false;
    expect(await notifyOnce(pool, flaky, board)).toBe(4);
  });

  it('закрытое расхождение и выключенный аккаунт не тревожат', async () => {
    await pool.query(`UPDATE reconciliation_issues SET resolved = true`);
    await pool.query(`UPDATE merchant_accounts SET enabled = false`);
    const { sender } = collector();
    expect(await notifyOnce(pool, sender, board)).toBe(2);
  });
});
