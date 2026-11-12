// Тестовый стенд для автотестов борды: пересоздаёт схему, накатывает миграции, готовит данные и запускает сервер.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPool } from '../dist/db/pool.js';
import { migrate } from '../dist/db/migrate.js';
import { generateApiKey } from '../dist/auth.js';
import { hashPassword } from '../dist/admin/security.js';

const url = process.env.E2E_DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!url) { console.error('Нужна E2E_DATABASE_URL или TEST_DATABASE_URL'); process.exit(1); }
const port = process.env.E2E_PORT || '3100';
const PASSWORD = 'e2e pass word 2026';

const pool = createPool(url);
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate(pool);
const op = (await pool.query(`INSERT INTO operators (name, licenses, platform_fee_bps, payout_kyc_required)
  VALUES ('Lucky Malta Ltd', '{MT,DE}', 150, false) RETURNING id`)).rows[0].id;
const key = generateApiKey();
await pool.query(`INSERT INTO sites (operator_id, name, api_key_hash) VALUES ($1, 'luckyspin.com', $2)`, [op, key.hash]);
const prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Тестовый провайдер', 'mock') RETURNING id`)).rows[0].id;
await pool.query(`INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, credentials_ref)
  VALUES ($1, $2, 'Тест · EUR', '{EUR}', '{MT,DE}', 100, 1000000, 10000000, 190, 'MOCK')`, [op, prov]);
const hash = await hashPassword(PASSWORD);
for (const [email, role, mustChange] of [['admin@e2e.test', 'admin', false], ['operator@e2e.test', 'operator', false],
  ['viewer@e2e.test', 'viewer', false], ['fresh@e2e.test', 'admin', true]]) {
  await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4)`, [email, hash, role, mustChange]);
}
await pool.end();
mkdirSync('e2e/.state', { recursive: true });
writeFileSync('e2e/.state/fixtures.json', JSON.stringify({ siteKey: key.key, password: PASSWORD }));

const child = spawn(process.execPath, ['dist/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env, DATABASE_URL: url, PORT: port, HOST: '127.0.0.1', PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), MOCK_PROVIDER_ENABLED: 'true', MOCK_DECLINE_RATE: '0', MOCK_DUPLICATE_WEBHOOK_RATE: '0', PROVIDER_SECRET_MOCK: 'e2e-mock-secret',
    LOG_LEVEL: 'warn', RECONCILE_AFTER_SEC: '600', NODE_ENV: 'test',
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
