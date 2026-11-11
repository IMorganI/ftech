// Демо-данные для локальной разработки: npm run seed
// Создаёт оператора, сайт (печатает его API-ключ один раз), мок-провайдера и несколько аккаунтов.
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { generateApiKey } from '../auth.js';
import { encrypt, parseEncryptionKey, randomSecret } from '../crypto.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const webhookUrl = process.argv[2] ?? null; // npm run seed -- https://my-site.test/hooks
try {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM operators`);
  if (rows[0].n > 0) {
    console.log('В базе уже есть данные — сид пропущен.');
  } else {
    const op = (await pool.query(
      `INSERT INTO operators (name, licenses, kyc_required_above) VALUES ('Demo Operator', '{MT,DE,IE,BR,CA}', 30000) RETURNING id`,
    )).rows[0].id;
    const { key, hash } = generateApiKey();
    const webhookSecret = randomSecret('whsec_');
    await pool.query(
      `INSERT INTO sites (operator_id, name, api_key_hash, webhook_url, webhook_secret_enc) VALUES ($1, 'demo-casino', $2, $3, $4)`,
      [op, hash, webhookUrl, encrypt(parseEncryptionKey(config.ENCRYPTION_KEY), webhookSecret)]);
    const prov = (await pool.query(
      `INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Мок-провайдер', 'mock') RETURNING id`,
    )).rows[0].id;
    const accounts: [string, string, string, number, number, number, number][] = [
      // name, currencies, countries, min, max, daily_cap, fee_bps   (суммы в центах)
      ['A · EUR-1', '{EUR}', '{MT,DE,IE}', 1000, 200000, 600000, 220],
      ['A · EUR-2', '{EUR}', '{MT,DE,IE}', 1000, 200000, 400000, 220],
      ['B · EUR', '{EUR}', '{DE,IE}', 2000, 500000, 800000, 310],
      ['C · Multi', '{EUR,CAD}', '{MT,IE,CA}', 500, 80000, 300000, 180],
      ['D · BRL', '{BRL}', '{BR}', 2000, 1000000, 3000000, 150],
    ];
    for (const [name, cur, geo, min, max, cap, fee] of accounts) {
      await pool.query(
        `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, credentials_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'MOCK')`, [op, prov, name, cur, geo, min, max, cap, fee]);
    }
    console.log('Готово. Сохрани, больше не покажется:\n');
    console.log('  API-ключ сайта demo-casino:   ' + key);
    console.log('  Секрет подписи вебхуков сайта: ' + webhookSecret + '\n');
  }
} finally {
  await pool.end();
}
