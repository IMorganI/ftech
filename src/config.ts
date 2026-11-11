import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL не задан'),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY не задан (openssl rand -base64 32)'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  MOCK_PROVIDER_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
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
