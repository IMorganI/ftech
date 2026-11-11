import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from './pool.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Применяет миграции из migrations/*.sql по порядку, каждую в своей транзакции. Возвращает имена применённых. */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Защита от одновременного запуска миграций с двух машин.
    await client.query('SELECT pg_advisory_lock(727001)');
    try {
      const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      const applied: string[] = [];
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(path.join(dir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Миграция ${file} упала: ${(err as Error).message}`);
        }
      }
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock(727001)');
    }
  } finally {
    client.release();
  }
}

// Запуск из командной строки: npm run migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadConfig } = await import('../config.js');
  const { createPool } = await import('./pool.js');
  const pool = createPool(loadConfig().DATABASE_URL);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет');
  } finally {
    await pool.end();
  }
}
