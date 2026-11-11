-- Связь с провайдерами и вебхуки.

-- Куда вернуть игрока после страницы оплаты провайдера.
ALTER TABLE transactions ADD COLUMN return_url text;

-- Попытка у провайдера: его ID платежа, ссылка на страницу оплаты, когда отправили.
ALTER TABLE transaction_attempts ADD COLUMN redirect_url text;
ALTER TABLE transaction_attempts ADD COLUMN submitted_at timestamptz;
CREATE UNIQUE INDEX transaction_attempts_provider_ref_idx
  ON transaction_attempts (merchant_account_id, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX transaction_attempts_pending_idx ON transaction_attempts (submitted_at) WHERE status = 'pending';

-- Секрет для подписи вебхуков сайту. Хранится зашифрованным (AES-256-GCM) ключом из ENCRYPTION_KEY.
ALTER TABLE sites ADD COLUMN webhook_secret_enc text;

-- Все входящие вебхуки провайдеров: защита от повторной обработки и след для разборов.
CREATE TABLE provider_webhook_events (
  id                  bigserial PRIMARY KEY,
  merchant_account_id uuid NOT NULL REFERENCES merchant_accounts(id),
  event_id            text NOT NULL,
  provider_ref        text,
  body                text NOT NULL,
  result              text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_account_id, event_id)
);

-- Очередь исходящих вебхуков сайтам (outbox): событие пишется в той же транзакции, что и смена статуса,
-- отдельный воркер доставляет его с повторами. Ни одно уведомление не теряется при падении процесса.
CREATE TYPE delivery_status AS ENUM ('pending', 'delivered', 'failed');
CREATE TABLE webhook_deliveries (
  id               bigserial PRIMARY KEY,
  site_id          uuid NOT NULL REFERENCES sites(id),
  transaction_id   uuid REFERENCES transactions(id),
  event            text NOT NULL,
  payload          jsonb NOT NULL,
  status           delivery_status NOT NULL DEFAULT 'pending',
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Расхождения, которые должен разобрать человек. Например: провайдер подтвердил оплату по попытке,
-- которую мы уже считали отклонённой, — деньги пришли, но платёж ушёл дальше по каскаду.
CREATE TABLE reconciliation_issues (
  id              bigserial PRIMARY KEY,
  transaction_id  uuid REFERENCES transactions(id),
  attempt_id      uuid REFERENCES transaction_attempts(id),
  kind            text NOT NULL,
  details         text NOT NULL,
  resolved        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_issues_open_idx ON reconciliation_issues (created_at) WHERE NOT resolved;
