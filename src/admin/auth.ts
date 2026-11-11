import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../db/pool.js';
import type { Client } from '../db/tx.js';
import QRCode from 'qrcode';
import { decrypt, encrypt } from '../crypto.js';
import {
  hashPassword, verifyPassword, passwordProblem, newTotpSecret, verifyTotp, otpauthUrl,
  newSessionToken, hashToken,
} from './security.js';

export type Role = 'viewer' | 'operator' | 'admin';
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export interface AdminContext {
  userId: string;
  email: string;
  role: Role;
  sessionId: string;
  mustChangePassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminContext;
  }
}

export interface AdminDeps {
  pool: Pool;
  encryptionKey: Buffer;
  /** Ставить cookie только по HTTPS (в проде всегда true). */
  secureCookies: boolean;
  /** Попыток входа в минуту с одного IP (по умолчанию 10). */
  loginRateLimitPerMinute?: number;
}

export const COOKIE = 'ftech_admin';
const SESSION_HOURS = 12;
const IDLE_MINUTES = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function audit(
  db: Pool | Client,
  e: { userId: string | null; action: string; entity?: string; entityId?: string | null; before?: unknown; after?: unknown; ip?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (admin_user_id, action, entity, entity_id, before, after, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.userId, e.action, e.entity ?? null, e.entityId ?? null,
     e.before === undefined ? null : JSON.stringify(e.before, bigintReplacer),
     e.after === undefined ? null : JSON.stringify(e.after, bigintReplacer), e.ip ?? null],
  );
}

export function bigintReplacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v;
}

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

/** Проверка сессии и роли. allowPasswordChange — маршрут доступен до смены временного пароля. */
export function requireAdmin(d: AdminDeps, minRole: Role = 'viewer', opts: { allowPasswordChange?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE];
    if (!token) return fail(reply, 401, 'unauthorized', 'Нужно войти');
    const s = (await d.pool.query(
      `SELECT s.id, s.mfa_passed, s.expires_at, s.last_seen_at, u.id AS user_id, u.email, u.role, u.disabled, u.must_change_password
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND NOT s.revoked`, [hashToken(token)],
    )).rows[0];
    const now = Date.now();
    if (!s || s.disabled || !s.mfa_passed || new Date(s.expires_at).getTime() < now
        || new Date(s.last_seen_at).getTime() < now - IDLE_MINUTES * 60_000) {
      return fail(reply, 401, 'unauthorized', 'Сессия истекла, войдите снова');
    }
    if (new Date(s.last_seen_at).getTime() < now - 60_000) {
      await d.pool.query(`UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1`, [s.id]);
    }
    req.admin = { userId: s.user_id, email: s.email, role: s.role, sessionId: s.id, mustChangePassword: s.must_change_password };
    if (s.must_change_password && !opts.allowPasswordChange) {
      return fail(reply, 403, 'password_change_required', 'Сначала смените временный пароль');
    }
    if (RANK[s.role as Role] < RANK[minRole]) {
      return fail(reply, 403, 'forbidden', `Нужна роль «${minRole}» или выше`);
    }
  };
}

export async function authRoutes(app: FastifyInstance, d: AdminDeps) {
  const { pool } = d;
  const cookieOpts = { path: '/admin', httpOnly: true, secure: d.secureCookies, sameSite: 'strict' as const };

  // Пара секунд на каждый неверный пароль — и так дорого, плюс жёсткий лимит на IP.
  const loginLimit = { config: { rateLimit: { max: d.loginRateLimitPerMinute ?? 10, timeWindow: '1 minute' } } };

  // Шаг 1: email + пароль. Отдаёт сессию, которая ещё ничего не может, пока не пройден второй фактор.
  app.post('/admin/v1/auth/login', loginLimit, async (req, reply) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'invalid_request', 'Нужны email и пароль');
    const email = body.data.email.toLowerCase();
    const u = (await pool.query(
      `SELECT id, password_hash, disabled, locked_until, totp_enabled FROM admin_users WHERE email = $1`, [email],
    )).rows[0];

    if (u?.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      const min = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60_000);
      return fail(reply, 423, 'locked', `Слишком много неверных попыток. Попробуйте через ${min} мин`);
    }
    // Для несуществующего email тоже считаем хэш: по времени ответа нельзя узнать, есть ли такой пользователь.
    const ok = await verifyPassword(body.data.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || u.disabled) {
      if (u) await registerFailure(pool, u.id, req.ip, 'password');
      return fail(reply, 401, 'invalid_credentials', 'Неверный email или пароль');
    }

    await pool.query(`UPDATE admin_users SET failed_logins = 0 WHERE id = $1`, [u.id]);
    const { token, hash } = newSessionToken();
    await pool.query(
      `INSERT INTO admin_sessions (token_hash, user_id, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
      [hash, u.id, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), SESSION_HOURS],
    );
    reply.setCookie(COOKIE, token, { ...cookieOpts, maxAge: SESSION_HOURS * 3600 });

    if (u.totp_enabled) return { next: 'totp' };
    // 2FA ещё не настроена: выдаём новый секрет, включится после первого верного кода.
    const secret = newTotpSecret();
    await pool.query(`UPDATE admin_users SET totp_secret_enc = $2 WHERE id = $1`, [u.id, encrypt(d.encryptionKey, secret)]);
    const url = otpauthUrl(secret, email);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { next: 'totp_setup', totpSecret: secret, otpauthUrl: url, qrSvg };
  });

  // Шаг 2: код из приложения-аутентификатора.
  app.post('/admin/v1/auth/totp', loginLimit, async (req, reply) => {
    const code = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!code.success) return fail(reply, 400, 'invalid_request', 'Нужен 6-значный код');
    const token = req.cookies[COOKIE];
    const s = token ? (await pool.query(
      `SELECT s.id, s.user_id, u.email, u.totp_secret_enc, u.totp_enabled, u.totp_last_step, u.locked_until, u.must_change_password
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND NOT s.revoked AND NOT s.mfa_passed AND s.expires_at > now() AND NOT u.disabled`,
      [hashToken(token)],
    )).rows[0] : null;
    if (!s || !s.totp_secret_enc) return fail(reply, 401, 'unauthorized', 'Сначала войдите по паролю');
    if (s.locked_until && new Date(s.locked_until).getTime() > Date.now()) {
      return fail(reply, 423, 'locked', 'Слишком много неверных попыток, попробуйте позже');
    }
    const step = verifyTotp(decrypt(d.encryptionKey, s.totp_secret_enc), code.data.code,
      s.totp_last_step === null ? null : Number(s.totp_last_step));
    if (step === null) {
      await registerFailure(pool, s.user_id, req.ip, 'totp');
      return fail(reply, 401, 'invalid_code', 'Неверный код');
    }
    await pool.query(
      `UPDATE admin_users SET totp_last_step = $2, totp_enabled = true, failed_logins = 0, last_login_at = now() WHERE id = $1`,
      [s.user_id, step],
    );
    // Новый токен после второго фактора: старый (выданный до 2FA) больше не действует.
    const { token: fresh, hash } = newSessionToken();
    await pool.query(`UPDATE admin_sessions SET mfa_passed = true, token_hash = $2, last_seen_at = now() WHERE id = $1`, [s.id, hash]);
    reply.setCookie(COOKIE, fresh, { ...cookieOpts, maxAge: SESSION_HOURS * 3600 });
    await audit(pool, { userId: s.user_id, action: s.totp_enabled ? 'auth.login' : 'auth.totp_enabled', ip: req.ip });
    return { next: s.must_change_password ? 'change_password' : 'done' };
  });

  app.post('/admin/v1/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await pool.query(`UPDATE admin_sessions SET revoked = true WHERE token_hash = $1`, [hashToken(token)]);
    reply.clearCookie(COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get('/admin/v1/me', { preHandler: requireAdmin(d, 'viewer', { allowPasswordChange: true }) }, async (req) => {
    const a = req.admin!;
    return { id: a.userId, email: a.email, role: a.role, mustChangePassword: a.mustChangePassword };
  });

  app.post('/admin/v1/me/password', { preHandler: requireAdmin(d, 'viewer', { allowPasswordChange: true }) }, async (req, reply) => {
    const b = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }).safeParse(req.body);
    if (!b.success) return fail(reply, 400, 'invalid_request', 'Нужны currentPassword и newPassword');
    const problem = passwordProblem(b.data.newPassword);
    if (problem) return fail(reply, 400, 'weak_password', problem);
    const u = (await pool.query(`SELECT password_hash FROM admin_users WHERE id = $1`, [req.admin!.userId])).rows[0];
    if (!(await verifyPassword(b.data.currentPassword, u.password_hash))) return fail(reply, 401, 'invalid_credentials', 'Текущий пароль неверный');
    if (b.data.currentPassword === b.data.newPassword) return fail(reply, 400, 'weak_password', 'Новый пароль совпадает со старым');
    await pool.query(`UPDATE admin_users SET password_hash = $2, must_change_password = false WHERE id = $1`,
      [req.admin!.userId, await hashPassword(b.data.newPassword)]);
    // Все остальные сессии пользователя закрываются.
    await pool.query(`UPDATE admin_sessions SET revoked = true WHERE user_id = $1 AND id <> $2`, [req.admin!.userId, req.admin!.sessionId]);
    await audit(pool, { userId: req.admin!.userId, action: 'auth.password_changed', ip: req.ip });
    return { ok: true };
  });
}

async function registerFailure(pool: Pool, userId: string, ip: string, kind: 'password' | 'totp') {
  const r = (await pool.query(
    `UPDATE admin_users SET failed_logins = failed_logins + 1,
       locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1 RETURNING failed_logins`, [userId, MAX_FAILED, LOCK_MINUTES],
  )).rows[0];
  if (r.failed_logins >= MAX_FAILED) await pool.query(`UPDATE admin_users SET failed_logins = 0 WHERE id = $1`, [userId]);
  await audit(pool, { userId, action: `auth.${kind}_failed`, ip, after: { failedLogins: r.failed_logins } });
}

// Хэш случайного пароля — для выравнивания времени ответа на несуществующий email.
const DUMMY_HASH = 'scrypt$32768$8$1$c2FsdHNhbHRzYWx0c2FsdA$Ub0dpgfOdQf0Hs3kd8F9t5SyT0aV8uG0hYB7bOpQ6qQ';
