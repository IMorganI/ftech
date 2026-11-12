import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import type { SecretStore } from '../secrets.js';
import { decrypt, encrypt } from '../crypto.js';
import type { AccountCredentials, ProviderAdapter } from './types.js';

/*
 * Ключи провайдера для мерчант-аккаунта.
 *  1. credentials_enc — введены в борде, зашифрованы ENCRYPTION_KEY (основной путь).
 *  2. credentials_ref — секрет из окружения/хранилища (PROVIDER_SECRET_<REF>), для совместимости.
 * Формат секрета — строка, которую понимает адаптер (у Viva — JSON с полями).
 */

export interface CredentialDeps {
  pool: Pool;
  secrets: SecretStore;
  encryptionKey?: Buffer;
}

export async function accountCredentials(d: CredentialDeps, accountId: string): Promise<AccountCredentials> {
  const r = (await d.pool.query(`SELECT credentials_enc, credentials_ref FROM merchant_accounts WHERE id = $1`, [accountId])).rows[0];
  if (!r) throw new Error(`Аккаунт ${accountId} не найден`);
  if (r.credentials_enc) {
    if (!d.encryptionKey) throw new Error('Нет ENCRYPTION_KEY — не могу расшифровать ключи аккаунта');
    return { accountId, secret: decrypt(d.encryptionKey, r.credentials_enc) };
  }
  if (r.credentials_ref) return { accountId, secret: await d.secrets.get(r.credentials_ref) };
  throw new Error('У аккаунта не заданы ключи провайдера — введи их в разделе «Подключения»');
}

/** Текущие значения полей (для формы): несекретные — как есть, секретные — замаскированы. */
export function describeValues(adapter: ProviderAdapter, secret: string | null): Record<string, { value?: string; masked?: string }> {
  const out: Record<string, { value?: string; masked?: string }> = {};
  let parsed: Record<string, unknown> = {};
  try { parsed = secret ? JSON.parse(secret) : {}; } catch { /* не JSON — показывать нечего */ }
  for (const f of adapter.manifest.fields) {
    const v = parsed[f.key];
    if (typeof v !== 'string' || !v) continue;
    out[f.key] = f.secret ? { masked: `••••${v.slice(-4)}` } : { value: v };
  }
  return out;
}

/**
 * Собрать новые ключи из формы. Правила:
 *  - поле, которого нет в форме, не меняется (ключи и секрет вебхука сохраняются разными формами);
 *  - пустое секретное поле — оставить прежнее значение; пустое обычное — значение по умолчанию;
 *  - обязательные поля проверяются по итоговому набору.
 */
export function buildSecret(adapter: ProviderAdapter, previous: string | null, input: Record<string, string>): string {
  const fields = adapter.manifest.fields;
  // Адаптер без полей (тестовый) — просто случайный секрет для подписи.
  if (!fields.length) return previous ?? randomBytes(24).toString('hex');
  let prev: Record<string, unknown> = {};
  try { prev = previous ? JSON.parse(previous) : {}; } catch { prev = {}; }
  const next: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const old = typeof prev[f.key] === 'string' ? (prev[f.key] as string) : '';
    let value: string;
    if (!(f.key in input)) value = old || f.default || '';
    else {
      const raw = (input[f.key] ?? '').trim();
      value = raw || (f.secret ? old : '') || f.default || '';
    }
    if (f.required && !value) missing.push(f.label);
    if (f.options && value && !f.options.includes(value)) throw new Error(`«${f.label}»: допустимо ${f.options.join(' или ')}`);
    if (value) next[f.key] = value;
  }
  if (missing.length) throw new Error(`Заполни: ${missing.join(', ')}`);
  return JSON.stringify(next);
}

/** Задано ли поле в секрете аккаунта (для шага «Вебхук»: введён ли секрет подписи). */
export function hasValue(secret: string | null, key: string): boolean {
  try { const v = secret ? (JSON.parse(secret) as Record<string, unknown>)[key] : null; return typeof v === 'string' && v.length > 0; }
  catch { return false; }
}

/**
 * Токен адреса вебхука. Создаётся сразу с аккаунтом. Для старых аккаунтов Viva переносится из ключей
 * (поле webhookToken), чтобы адрес, уже вставленный в кабинет провайдера, продолжил работать.
 */
export async function ensureWebhookToken(d: CredentialDeps, accountId: string): Promise<string> {
  const row = (await d.pool.query(`SELECT webhook_token FROM merchant_accounts WHERE id = $1`, [accountId])).rows[0];
  if (!row) throw new Error(`Аккаунт ${accountId} не найден`);
  if (row.webhook_token) return row.webhook_token;
  let token: string | null = null;
  try {
    const legacy = (JSON.parse((await accountCredentials(d, accountId)).secret) as Record<string, unknown>).webhookToken;
    if (typeof legacy === 'string' && legacy.length >= 16) token = legacy;
  } catch { /* ключей нет или не JSON — создадим новый */ }
  token ??= randomBytes(24).toString('hex');
  return (await d.pool.query(
    `UPDATE merchant_accounts SET webhook_token = coalesce(webhook_token, $2) WHERE id = $1 RETURNING webhook_token`,
    [accountId, token])).rows[0].webhook_token;
}

export function sameToken(got: unknown, want: string | null): boolean {
  if (!want || typeof got !== 'string') return false;
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encryptSecret(key: Buffer, secret: string): string {
  return encrypt(key, secret);
}

