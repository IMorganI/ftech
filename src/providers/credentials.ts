import { randomBytes } from 'node:crypto';
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
  for (const f of adapter.credentialFields ?? []) {
    const v = parsed[f.key];
    if (typeof v !== 'string' || !v) continue;
    out[f.key] = f.secret ? { masked: `••••${v.slice(-4)}` } : { value: v };
  }
  return out;
}

/**
 * Собрать и зашифровать новые ключи. Пустое секретное поле = оставить прежнее значение.
 * Токен вебхука (если адаптеру нужен) генерируется один раз и сохраняется при последующих правках.
 */
export function buildSecret(adapter: ProviderAdapter, previous: string | null, input: Record<string, string>): string {
  let prev: Record<string, unknown> = {};
  try { prev = previous ? JSON.parse(previous) : {}; } catch { prev = {}; }
  const next: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const f of adapter.credentialFields ?? []) {
    const raw = (input[f.key] ?? '').trim();
    const value = raw || (f.secret ? (prev[f.key] as string | undefined) ?? '' : '') || f.default || '';
    if (f.required && !value) missing.push(f.label);
    if (f.options && value && !f.options.includes(value)) throw new Error(`«${f.label}»: допустимо ${f.options.join(' или ')}`);
    if (value) next[f.key] = value;
  }
  if (missing.length) throw new Error(`Заполни: ${missing.join(', ')}`);
  if (adapter.webhook?.tokenField) {
    next[adapter.webhook.tokenField] = (prev[adapter.webhook.tokenField] as string | undefined) ?? randomBytes(24).toString('hex');
  }
  // Адаптер без полей (тестовый) — просто случайный секрет для подписи.
  if (!(adapter.credentialFields ?? []).length) return (previous ?? randomBytes(24).toString('hex'));
  return JSON.stringify(next);
}

export function encryptSecret(key: Buffer, secret: string): string {
  return encrypt(key, secret);
}

export function webhookToken(adapter: ProviderAdapter, secret: string): string | null {
  if (!adapter.webhook?.tokenField) return null;
  try { return (JSON.parse(secret) as Record<string, string>)[adapter.webhook.tokenField] ?? null; } catch { return null; }
}
