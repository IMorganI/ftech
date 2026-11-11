// Создание пользователя админки из командной строки (первый админ):
//   npm run admin:create -- you@company.com admin
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { hashPassword, temporaryPassword } from './security.js';
import { audit } from './auth.js';

const [email, role = 'admin'] = process.argv.slice(2);
if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || !['viewer', 'operator', 'admin'].includes(role)) {
  console.error('Использование: npm run admin:create -- <email> [viewer|operator|admin]');
  process.exit(1);
}
const pool = createPool(loadConfig().DATABASE_URL);
try {
  const temp = temporaryPassword();
  const row = (await pool.query(
    `INSERT INTO admin_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
    [email.toLowerCase(), await hashPassword(temp), role])).rows[0];
  await audit(pool, { userId: null, action: 'user.create_cli', entity: 'user', entityId: row.id, after: { email, role } });
  console.log(`Пользователь ${email} (${role}) создан.`);
  console.log(`Временный пароль (показывается один раз): ${temp}`);
  console.log('При первом входе нужно будет настроить 2FA и сменить пароль.');
} catch (err) {
  console.error((err as { code?: string }).code === '23505' ? 'Такой пользователь уже есть' : (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
