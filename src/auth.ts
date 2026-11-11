import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from './db/pool.js';

export interface SiteContext {
  siteId: string;
  operatorId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    site?: SiteContext;
  }
}

const KEY_PREFIX = 'ftk_';

/** Новый API-ключ сайта. Сам ключ показывается один раз, в базе хранится только его хэш. */
export function generateApiKey(): { key: string; hash: string } {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function siteAuth(pool: Pool) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key.startsWith(KEY_PREFIX)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Нужен заголовок Authorization: Bearer <API-ключ сайта>' } });
    }
    const r = await pool.query(
      `SELECT s.id, s.operator_id FROM sites s WHERE s.api_key_hash = $1 AND s.enabled`, [hashApiKey(key)],
    );
    if (!r.rows[0]) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Ключ не найден или сайт отключён' } });
    }
    req.site = { siteId: r.rows[0].id, operatorId: r.rows[0].operator_id };
  };
}
