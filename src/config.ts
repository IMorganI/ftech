import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL не задан'),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY не задан (openssl rand -base64 32)'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Куда провайдеры шлют вебхуки, если не на PUBLIC_BASE_URL (например, адрес туннеля Cloudflare).
  WEBHOOK_BASE_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  MOCK_PROVIDER_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // За балансировщиком/прокси (Codespaces, облако): брать IP клиента из X-Forwarded-For.
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Через сколько секунд после отправки сверка сама спрашивает провайдера о статусе (если не пришёл вебхук).
  RECONCILE_AFTER_SEC: z.coerce.number().int().min(10).default(60),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  WORKERS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Ошибка конфигурации: ${issues}`);
  }
  return parsed.data;
}
