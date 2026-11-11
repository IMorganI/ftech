import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// ---------- пароли: scrypt с солью ----------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(got, expected);
}

/** Пароль: минимум 12 символов, буквы и цифры. Длина важнее «сложности». */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return 'Минимум 12 символов';
  if (pw.length > 200) return 'Слишком длинный';
  if (!/[a-zA-Zа-яА-Я]/.test(pw) || !/\d/.test(pw)) return 'Нужны и буквы, и цифры';
  return null;
}

export function temporaryPassword(): string {
  return randomBytes(12).toString('base64url') + '7';
}

// ---------- 2FA: TOTP по RFC 6238 (Google Authenticator, 1Password, Authy) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Неверный base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export const totpStep = (ms = Date.now()) => Math.floor(ms / 1000 / 30);

/**
 * Проверяет код с допуском ±1 шаг (часы телефона могут немного спешить).
 * Возвращает шаг совпавшего кода или null. Шаг ≤ lastStep отвергается — код нельзя использовать дважды.
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = totpStep(now);
  for (const s of [cur - 1, cur, cur + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = totpAt(secretB32, s);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return s;
  }
  return null;
}

export function otpauthUrl(secretB32: string, email: string, issuer = 'ftech'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- сессии ----------

export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
