import pg from 'pg';

// BIGINT (int8) возвращаем как bigint, чтобы суммы в минорных единицах никогда не теряли точность.
pg.types.setTypeParser(20, (v) => BigInt(v));

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export type Pool = pg.Pool;
