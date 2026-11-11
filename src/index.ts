import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';
import { parseEncryptionKey } from './crypto.js';
import { EnvSecretStore } from './secrets.js';
import { ProviderRegistry } from './providers/types.js';
import { MockAdapter, MockProvider } from './providers/mock.js';
import { dispatchOnce } from './webhooks/outbox.js';
import { reconcilePending } from './payments/flow.js';

const config = loadConfig();
const encryptionKey = parseEncryptionKey(config.ENCRYPTION_KEY);
const pool = createPool(config.DATABASE_URL);
const secrets = new EnvSecretStore();
const providers = new ProviderRegistry();

let mock: MockProvider | undefined;
if (config.MOCK_PROVIDER_ENABLED) {
  mock = new MockProvider({ publicBaseUrl: config.PUBLIC_BASE_URL, instantDeclineRate: 0.1, duplicateWebhookRate: 0.2 });
  providers.register(new MockAdapter(mock));
}

const app = buildApp({
  pool, providers, secrets, mock, logLevel: config.LOG_LEVEL, rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
  admin: { encryptionKey, secureCookies: config.PUBLIC_BASE_URL.startsWith('https://') },
  trustProxy: config.TRUST_PROXY,
});

// Мок шлёт вебхуки в наш же сервер — через полный HTTP-путь с проверкой подписи.
if (mock) {
  mock.sink = async (accountId, headers, body) => {
    await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${accountId}`, headers, payload: body });
  };
}

// Фоновые задачи: доставка вебхуков сайтам и сверка зависших платежей.
const timers: NodeJS.Timeout[] = [];
if (config.WORKERS_ENABLED) {
  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    let running = false;
    timers.push(setInterval(async () => {
      if (running) return;
      running = true;
      try { await fn(); } catch (err) { app.log.error({ err }, `Воркер ${name} упал`); } finally { running = false; }
    }, everyMs));
  };
  loop('webhooks', 1000, () => dispatchOnce({ pool, encryptionKey }));
  loop('reconcile', 60_000, () => reconcilePending({ pool, providers, secrets }));
}

const shutdown = async () => {
  timers.forEach(clearInterval);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
