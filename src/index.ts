import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';
import { parseEncryptionKey } from './crypto.js';
import { EnvSecretStore } from './secrets.js';
import { ProviderRegistry } from './providers/types.js';
import { MockAdapter, MockProvider } from './providers/mock.js';
import { VivaAdapter } from './providers/viva.js';
import { TestPayAdapter, TestPaySimulator } from './providers/testpay.js';
import { dispatchOnce } from './webhooks/outbox.js';
import { reconcilePending, processInbox } from './payments/flow.js';
import { resumePayouts } from './payouts/payouts.js';
import { TelegramSender } from './notify/telegram.js';
import { notifyOnce } from './notify/alerts.js';

const config = loadConfig();
const encryptionKey = parseEncryptionKey(config.ENCRYPTION_KEY);
const pool = createPool(config.DATABASE_URL);
const secrets = new EnvSecretStore();
const providers = new ProviderRegistry().register(new VivaAdapter());

let mock: MockProvider | undefined;
if (config.MOCK_PROVIDER_ENABLED) {
  mock = new MockProvider({ publicBaseUrl: config.PUBLIC_BASE_URL, instantDeclineRate: 0.1, duplicateWebhookRate: 0.2 });
  providers.register(new MockAdapter(mock));
}
// Учебный провайдер с подписью вебхуков — для проверки сценария подключения «как у настоящих».
let testpay: TestPaySimulator | undefined;
if (config.MOCK_PROVIDER_ENABLED) {
  testpay = new TestPaySimulator(config.PUBLIC_BASE_URL, '.data/testpay.json');
  providers.register(new TestPayAdapter(testpay));
}

const app = buildApp({
  pool, providers, secrets, mock, testpay, logLevel: config.LOG_LEVEL, rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE, rateLimitPerIpPerMinute: config.RATE_LIMIT_PER_IP_PER_MINUTE,
  admin: { encryptionKey, secureCookies: config.PUBLIC_BASE_URL.startsWith('https://'), webhookBaseUrl: config.WEBHOOK_BASE_URL ?? config.PUBLIC_BASE_URL },
  trustProxy: config.TRUST_PROXY,
});

// Мок шлёт вебхуки в наш же сервер — через полный HTTP-путь с проверкой подписи.
if (mock) {
  mock.sink = async (accountId, headers, body) => {
    await app.inject({ method: 'POST', url: `/v1/provider-webhooks/${accountId}`, headers, payload: body });
  };
}
// TestPay доставляет вебхуки только на этот же сервер (внутренним запросом, без выхода в сеть):
// из адреса берётся путь, хост не важен — так работает и с адресом Codespaces, и с туннелем.
if (testpay) {
  testpay.deliver = async (url, headers, body) => {
    const u = new URL(url);
    if (!u.pathname.startsWith('/v1/provider-webhooks/')) return 404;
    return (await app.inject({ method: 'POST', url: u.pathname + u.search, headers, payload: body })).statusCode;
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
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    const tg = new TelegramSender(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID);
    loop('telegram', 30_000, () => notifyOnce(pool, tg, `${config.PUBLIC_BASE_URL}/admin`));
  }
  loop('payouts', 30_000, () => resumePayouts({ pool, providers, secrets, encryptionKey }));
  loop('reconcile', 20_000, () => reconcilePending({ pool, providers, secrets, encryptionKey }, config.RECONCILE_AFTER_SEC));
  loop('inbox', 15_000, () => processInbox({ pool, providers, secrets, encryptionKey }));
  // Журнал входящих вебхуков нужен для разборов настройки — храним 30 дней.
  loop('webhook-log', 3_600_000, () => pool.query(`DELETE FROM provider_webhook_log WHERE received_at < now() - interval '30 days'`));
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
