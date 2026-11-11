// Админка: вход с 2FA, роли, аудит, управление ключами и аккаунтами.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createPool, type Pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, totpAt, totpStep, verifyTotp, base32Encode } from '../src/admin/security.js';
import { ProviderRegistry } from '../src/providers/types.js';
import { MockAdapter, MockProvider } from '../src/providers/mock.js';
import { MapSecretStore } from '../src/secrets.js';
import { resolveAttempt } from '../src/routing/router.js';

const url = process.env.TEST_DATABASE_URL;
const ENC_KEY = Buffer.alloc(32, 9);
const PW = 'correct horse 42 battery';

describe('TOTP', () => {
  it('совпадает с эталоном RFC 6238', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 1)).toBe('287082');            // T = 59 c
    expect(totpAt(secret, 37037036)).toBe('081804');     // T = 1111111109 c
  });
  it('не принимает тот же код дважды', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 59_000;
    const step = verifyTotp(secret, totpAt(secret, 1), null, now);
    expect(step).toBe(1);
    expect(verifyTotp(secret, totpAt(secret, 1), step, now)).toBeNull();
  });
});

describe.skipIf(!url)('Админка', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let op: string;
  let prov: string;
  const lastStep = new Map<string, number>();
  const secrets = new Map<string, string>();

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    const mock = new MockProvider({ publicBaseUrl: 'https://pay.test' });
    app = buildApp({ pool, mock, providers: new ProviderRegistry().register(new MockAdapter(mock)),
      secrets: new MapSecretStore({ MOCK: 's' }), admin: { encryptionKey: ENC_KEY, secureCookies: false, loginRateLimitPerMinute: 100000 }, rateLimitPerMinute: 100000 });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  beforeEach(async () => {
    await pool.query(`TRUNCATE audit_log, admin_sessions, admin_users, reconciliation_issues, webhook_deliveries, provider_webhook_events,
      ledger_entries, transaction_attempts, transactions, account_usage, players, merchant_accounts, sites, providers, operators CASCADE`);
    lastStep.clear(); secrets.clear();
    op = (await pool.query(`INSERT INTO operators (name, licenses) VALUES ('Op', '{MT}') RETURNING id`)).rows[0].id;
    prov = (await pool.query(`INSERT INTO providers (code, name, adapter) VALUES ('mock', 'Mock', 'mock') RETURNING id`)).rows[0].id;
  });

  async function user(email: string, role: 'viewer' | 'operator' | 'admin', mustChange = false) {
    await pool.query(`INSERT INTO admin_users (email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4)`,
      [email, await hashPassword(PW), role, mustChange]);
  }

  const cookieOf = (res: LightMyRequestResponse) => (res.cookies as { name: string; value: string }[]).find((c) => c.name === 'ftech_admin')?.value;

  function nextCode(email: string) {
    const step = Math.max(totpStep(), (lastStep.get(email) ?? -1) + 1);
    lastStep.set(email, step);
    return totpAt(secrets.get(email)!, step);
  }

  /** Полный вход: пароль → (настройка) 2FA → сессия. */
  async function login(email: string, password = PW) {
    const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email, password } });
    expect(r1.statusCode, r1.body).toBe(200);
    if (r1.json().next === 'totp_setup') secrets.set(email, r1.json().totpSecret);
    const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: nextCode(email) }, cookies: { ftech_admin: cookieOf(r1)! } });
    expect(r2.statusCode, r2.body).toBe(200);
    return { cookie: cookieOf(r2)!, next: r2.json().next as string };
  }

  const as = (cookie: string) => ({
    get: (u: string) => app.inject({ method: 'GET', url: u, cookies: { ftech_admin: cookie } }),
    post: (u: string, payload: object = {}) => app.inject({ method: 'POST', url: u, payload, cookies: { ftech_admin: cookie } }),
    patch: (u: string, payload: object) => app.inject({ method: 'PATCH', url: u, payload, cookies: { ftech_admin: cookie } }),
  });

  async function account(name: string, fee = 100) {
    return (await pool.query(
      `INSERT INTO merchant_accounts (operator_id, provider_id, name, currencies, countries, min_amount, max_amount, daily_cap, fee_bps, credentials_ref)
       VALUES ($1, $2, $3, '{EUR}', '{MT}', 100, 100000, 1000000, $4, 'MOCK') RETURNING id`, [op, prov, name, fee])).rows[0].id as string;
  }

  // ---------- вход ----------

  it('вход: пароль → настройка 2FA → доступ; до второго фактора доступа нет', async () => {
    await user('a@x.io', 'admin');
    expect((await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: 'wrong-pass-123' } })).statusCode).toBe(401);
    const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'A@X.io', password: PW } });
    expect(r1.json()).toMatchObject({ next: 'totp_setup' });
    expect(r1.json().otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const half = cookieOf(r1)!;
    expect((await as(half).get('/admin/v1/me')).statusCode).toBe(401); // пароль без 2FA ничего не даёт
    expect((await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: '000000' }, cookies: { ftech_admin: half } })).statusCode).toBe(401);
    secrets.set('a@x.io', r1.json().totpSecret);
    const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: nextCode('a@x.io') }, cookies: { ftech_admin: half } });
    expect(r2.json().next).toBe('done');
    expect(cookieOf(r2)).not.toBe(half); // после 2FA выдаётся новый токен
    expect((await as(half).get('/admin/v1/me')).statusCode).toBe(401);
    expect((await as(cookieOf(r2)!).get('/admin/v1/me')).json()).toMatchObject({ email: 'a@x.io', role: 'admin' });
  });

  it('при повторном входе 2FA уже настроена и тот же код не принимается', async () => {
    await user('a@x.io', 'admin');
    await login('a@x.io');
    const r1 = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: PW } });
    expect(r1.json()).toEqual({ next: 'totp' }); // секрет больше не показывается
    const reused = totpAt(secrets.get('a@x.io')!, lastStep.get('a@x.io')!);
    const r2 = await app.inject({ method: 'POST', url: '/admin/v1/auth/totp', payload: { code: reused }, cookies: { ftech_admin: cookieOf(r1)! } });
    expect(r2.statusCode).toBe(401);
  });

  it('после 5 неверных паролей аккаунт временно блокируется', async () => {
    await user('a@x.io', 'admin');
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: `bad-password-${i}` } });
    }
    const r = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: PW } });
    expect(r.statusCode).toBe(423);
    const fails = (await pool.query(`SELECT count(*)::int c FROM audit_log WHERE action = 'auth.password_failed'`)).rows[0].c;
    expect(fails).toBe(5);
  });

  it('больше 10 попыток входа в минуту с одного адреса — 429', async () => {
    const strict = buildApp({ pool, admin: { encryptionKey: ENC_KEY, secureCookies: false } });
    const codes = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await strict.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'x@x.io', password: 'whatever-123' } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    await strict.close();
  });

  it('несуществующий и заблокированный пользователь получают одинаковый ответ', async () => {
    await user('a@x.io', 'admin');
    await pool.query(`UPDATE admin_users SET disabled = true`);
    const a = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'a@x.io', password: PW } });
    const b = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'nobody@x.io', password: PW } });
    expect([a.statusCode, a.json()]).toEqual([b.statusCode, b.json()]);
  });

  it('временный пароль нужно сменить, прежде чем что-то делать', async () => {
    await user('root@x.io', 'admin');
    const { cookie: root } = await login('root@x.io');
    const created = (await as(root).post('/admin/v1/users', { email: 'new@x.io', role: 'viewer' })).json();
    expect(created.temporaryPassword).toBeTruthy();

    const { cookie, next } = await login('new@x.io', created.temporaryPassword);
    expect(next).toBe('change_password');
    expect((await as(cookie).get('/admin/v1/accounts')).json().error.code).toBe('password_change_required');
    expect((await as(cookie).post('/admin/v1/me/password', { currentPassword: created.temporaryPassword, newPassword: 'short1' })).statusCode).toBe(400);
    expect((await as(cookie).post('/admin/v1/me/password', { currentPassword: created.temporaryPassword, newPassword: 'a much longer pass 7' })).statusCode).toBe(200);
    expect((await as(cookie).get('/admin/v1/accounts')).statusCode).toBe(200);
  });

  it('сессия истекает после 30 минут бездействия; выход закрывает сессию', async () => {
    await user('a@x.io', 'viewer');
    const { cookie } = await login('a@x.io');
    expect((await as(cookie).get('/admin/v1/me')).statusCode).toBe(200);
    await pool.query(`UPDATE admin_sessions SET last_seen_at = now() - interval '31 minutes'`);
    expect((await as(cookie).get('/admin/v1/me')).statusCode).toBe(401);

    const { cookie: c2 } = await login('a@x.io');
    await as(c2).post('/admin/v1/auth/logout');
    expect((await as(c2).get('/admin/v1/me')).statusCode).toBe(401);
  });

  it('изменяющие запросы без JSON отклоняются (защита от CSRF)', async () => {
    await user('a@x.io', 'admin');
    const { cookie } = await login('a@x.io');
    const r = await app.inject({ method: 'POST', url: '/admin/v1/providers', cookies: { ftech_admin: cookie },
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'code=evil&name=x&adapter=mock' });
    expect(r.statusCode).toBe(415);
  });

  // ---------- роли ----------

  it('viewer только смотрит, operator меняет лимиты, но не структуру, admin — всё', async () => {
    const acc = await account('A');
    await user('v@x.io', 'viewer'); await user('o@x.io', 'operator'); await user('a@x.io', 'admin');
    const v = as((await login('v@x.io')).cookie);
    const o = as((await login('o@x.io')).cookie);
    const a = as((await login('a@x.io')).cookie);

    expect((await v.get('/admin/v1/accounts')).json()[0]).toMatchObject({ name: 'A', used_today: '0', daily_cap: '1000000' });
    expect((await v.patch(`/admin/v1/accounts/${acc}`, { enabled: false })).statusCode).toBe(403);
    expect((await v.get('/admin/v1/audit')).statusCode).toBe(403);

    expect((await o.patch(`/admin/v1/accounts/${acc}`, { dailyCap: 500000, priority: 5 })).json()).toMatchObject({ daily_cap: '500000', priority: 5 });
    const denied = await o.patch(`/admin/v1/accounts/${acc}`, { credentialsRef: 'OTHER' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/credentialsRef/);
    expect((await o.post('/admin/v1/providers', { code: 'x', name: 'X', adapter: 'mock' })).statusCode).toBe(403);

    expect((await a.patch(`/admin/v1/accounts/${acc}`, { name: 'A-renamed', countries: ['MT', 'DE'] })).json()).toMatchObject({ name: 'A-renamed' });
  });

  it('несогласованные лимиты отклоняются понятной ошибкой', async () => {
    const acc = await account('A');
    await user('a@x.io', 'admin');
    const a = as((await login('a@x.io')).cookie);
    const r = await a.patch(`/admin/v1/accounts/${acc}`, { minAmount: 500000 }); // больше max
    expect(r.statusCode).toBe(400);
  });

  // ---------- аудит ----------

  it('каждое изменение пишется в журнал со значениями до и после; журнал нельзя править', async () => {
    const acc = await account('A');
    await user('o@x.io', 'operator'); await user('a@x.io', 'admin');
    const o = as((await login('o@x.io')).cookie);
    await o.patch(`/admin/v1/accounts/${acc}`, { enabled: false });
    const a = as((await login('a@x.io')).cookie);
    const log = (await a.get(`/admin/v1/audit?entity=account&entityId=${acc}`)).json();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'account.update', user_email: 'o@x.io', before: { enabled: true }, after: { enabled: false } });
    await expect(pool.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/нельзя/);
    await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/нельзя/);
  });

  // ---------- сайты и ключи ----------

  it('ключ сайта показывается один раз, перевыпуск сразу отключает старый', async () => {
    await account('A');
    await user('a@x.io', 'admin');
    const a = as((await login('a@x.io')).cookie);
    const site = (await a.post('/admin/v1/sites', { operatorId: op, name: 'casino', webhookUrl: 'https://casino.test/hooks' })).json();
    expect(site.apiKey).toMatch(/^ftk_/);
    expect(site.webhookSecret).toMatch(/^whsec_/);

    const listed = JSON.stringify((await a.get('/admin/v1/sites')).json());
    expect(listed).not.toContain(site.apiKey);
    expect(listed).not.toContain('api_key_hash');
    expect(listed).not.toContain('webhook_secret_enc');

    const dep = (k: string) => app.inject({ method: 'POST', url: '/v1/deposits',
      headers: { authorization: `Bearer ${k}`, 'idempotency-key': `k-${Math.random()}` },
      payload: { amount: 1000, currency: 'EUR', player: { id: 'p', country: 'MT', kyc: 'verified' } } });
    expect((await dep(site.apiKey)).statusCode).toBe(201);
    const { apiKey: fresh } = (await a.post(`/admin/v1/sites/${site.id}/rotate-key`)).json();
    expect((await dep(site.apiKey)).statusCode).toBe(401);
    expect((await dep(fresh)).statusCode).toBe(201);

    const actions = (await a.get(`/admin/v1/audit?entity=site&entityId=${site.id}`)).json().map((x: { action: string }) => x.action);
    expect(actions).toEqual(['site.rotate_key', 'site.create']);
    expect(JSON.stringify((await a.get('/admin/v1/audit')).json())).not.toContain(fresh);
  });

  it('выключение аккаунта в админке сразу меняет маршрут платежей', async () => {
    const cheap = await account('Дешёвый', 100);
    await account('Запасной', 200);
    await user('o@x.io', 'operator'); await user('a@x.io', 'admin');
    const a = as((await login('a@x.io')).cookie);
    const { apiKey } = (await a.post('/admin/v1/sites', { operatorId: op, name: 's' })).json();
    const o = as((await login('o@x.io')).cookie);
    await o.patch(`/admin/v1/accounts/${cheap}`, { enabled: false });
    const d = (await app.inject({ method: 'POST', url: '/v1/deposits', headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'route-after-disable' },
      payload: { amount: 1000, currency: 'EUR', player: { id: 'p', country: 'MT', kyc: 'verified' } } })).json();
    const detail = (await o.get(`/admin/v1/transactions/${d.id}`)).json();
    expect(detail.attempts[0].account).toBe('Запасной');
    expect(detail.request_hash).toBeUndefined();
    expect((await o.get('/admin/v1/transactions?status=pending')).json()).toHaveLength(1);
  });

  // ---------- пользователи и расхождения ----------

  it('блокировка пользователя закрывает его сессии; себя заблокировать нельзя', async () => {
    await user('a@x.io', 'admin'); await user('v@x.io', 'viewer');
    const a = as((await login('a@x.io')).cookie);
    const vCookie = (await login('v@x.io')).cookie;
    const vid = (await pool.query(`SELECT id FROM admin_users WHERE email = 'v@x.io'`)).rows[0].id;
    const aid = (await pool.query(`SELECT id FROM admin_users WHERE email = 'a@x.io'`)).rows[0].id;
    expect((await a.patch(`/admin/v1/users/${aid}`, { disabled: true })).statusCode).toBe(400);
    await a.patch(`/admin/v1/users/${vid}`, { disabled: true });
    expect((await as(vCookie).get('/admin/v1/me')).statusCode).toBe(401);
  });

  it('сброс 2FA: при следующем входе настраивается заново', async () => {
    await user('a@x.io', 'admin'); await user('v@x.io', 'viewer');
    const a = as((await login('a@x.io')).cookie);
    await login('v@x.io');
    const vid = (await pool.query(`SELECT id FROM admin_users WHERE email = 'v@x.io'`)).rows[0].id;
    await a.post(`/admin/v1/users/${vid}/reset-2fa`);
    const r = await app.inject({ method: 'POST', url: '/admin/v1/auth/login', payload: { email: 'v@x.io', password: PW } });
    expect(r.json().next).toBe('totp_setup');
  });

  it('расхождение закрывается с комментарием, кто закрыл — видно', async () => {
    await user('o@x.io', 'operator');
    const o = as((await login('o@x.io')).cookie);
    const id = (await pool.query(`INSERT INTO reconciliation_issues (kind, details) VALUES ('late_success', 'тест') RETURNING id`)).rows[0].id;
    expect((await o.get('/admin/v1/issues')).json()).toHaveLength(1);
    expect((await o.post(`/admin/v1/issues/${id}/resolve`, { note: 'Вернули игроку вручную' })).statusCode).toBe(200);
    expect((await o.get('/admin/v1/issues')).json()).toHaveLength(0);
    expect((await o.get('/admin/v1/issues?all=true')).json()[0]).toMatchObject({ resolved: true, resolved_by_email: 'o@x.io' });
  });

  it('статистика: успешные депозиты, оборот, заработок платформы и расходы на провайдеров', async () => {
    await account('A', 200); // провайдер берёт 2%
    await user('a@x.io', 'admin');
    const a = as((await login('a@x.io')).cookie);
    await a.patch(`/admin/v1/operators/${op}`, { platformFeeBps: 150 }); // платформа берёт 1.5%
    const { apiKey } = (await a.post('/admin/v1/sites', { operatorId: op, name: 'casino' })).json();
    const dep = async (amount: number, key: string) => (await app.inject({ method: 'POST', url: '/v1/deposits',
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
      payload: { amount, currency: 'EUR', player: { id: key, country: 'MT', kyc: 'verified' } } })).json();
    const d1 = await dep(10000, 'stats-key-1'); await resolveAttempt(pool, d1.id, { status: 'success' });
    const d2 = await dep(3333, 'stats-key-2'); await resolveAttempt(pool, d2.id, { status: 'success' });
    await dep(5000, 'stats-key-3'); // ждёт оплаты
    await dep(1000, 'stats-key-4').then((d) => resolveAttempt(pool, d.id, { status: 'declined' })); // отказ, каскадить некуда

    const s = (await a.get('/admin/v1/stats?period=today&tz=Europe/Kyiv')).json();
    expect(s.totals).toEqual([{ currency: 'EUR', attempts: 4, succeeded: 2, declined: 1, pending: 1,
      volume: '13333', earned: '199', provider_cost: '266' }]); // 150 + 49 (округление вниз), 200 + 66
    expect(s.series.reduce((n: number, p: { succeeded: number }) => n + p.succeeded, 0)).toBe(2);
    expect(s.unit).toBe('hour');
    expect(s.bySite[0]).toMatchObject({ site: 'casino', succeeded: 2, attempts: 4, earned: '199' });
    expect(s.recent).toHaveLength(4);
    expect(s.platformFeeBps).toEqual({ min: 150, max: 150 });

    // Смена процента не переписывает уже заработанное
    await a.patch(`/admin/v1/operators/${op}`, { platformFeeBps: 1000 });
    expect((await a.get('/admin/v1/stats?period=7d')).json().totals[0].earned).toBe('199');
    expect((await a.get('/admin/v1/stats?period=30d')).json().series).toHaveLength(30);
    // Неизвестный пояс не ломает обзор: считаем в UTC; старое/новое название Киева понимается
    expect((await a.get('/admin/v1/stats?tz=Mars/Olympus')).json().tz).toBe('UTC');
    expect(['Europe/Kyiv', 'Europe/Kiev']).toContain((await a.get('/admin/v1/stats?tz=Europe/Kyiv')).json().tz);
  });

  it('сводка для борды', async () => {
    await user('v@x.io', 'viewer');
    const v = as((await login('v@x.io')).cookie);
    expect((await v.get('/admin/v1/overview')).json()).toMatchObject({ tx_24h: 0, pending: 0, open_issues: 0, volume_24h: {} });
  });
});
