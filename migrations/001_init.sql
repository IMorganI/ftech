-- Базовая схема оркестратора.
-- Все суммы хранятся в минорных единицах (центы, копейки) как BIGINT: никаких float для денег.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- Оператор: владелец лицензии (гемб-продукт), под которым работают сайты и мерчант-аккаунты.
CREATE TABLE operators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  licenses    text[] NOT NULL DEFAULT '{}',            -- например {MT, IE}: где разрешено работать
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Сайт оператора, который ходит в наш единый API.
CREATE TABLE sites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   uuid NOT NULL REFERENCES operators(id),
  name          text NOT NULL,
  api_key_hash  text NOT NULL UNIQUE,                  -- храним только хэш ключа, сам ключ показываем один раз
  webhook_url   text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Платёжный провайдер (тип интеграции). Конкретный код адаптера выбирается по adapter.
CREATE TABLE providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                    -- 'mock', 'viva', ...
  name        text NOT NULL,
  adapter     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Мерчант-аккаунт у провайдера: то, между чем роутер распределяет трафик.
CREATE TABLE merchant_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id    uuid NOT NULL REFERENCES operators(id),
  provider_id    uuid NOT NULL REFERENCES providers(id),
  name           text NOT NULL,
  currencies     char(3)[] NOT NULL,
  countries      char(2)[] NOT NULL,
  min_amount     bigint NOT NULL CHECK (min_amount > 0),
  max_amount     bigint NOT NULL,
  daily_cap      bigint NOT NULL CHECK (daily_cap > 0),
  monthly_cap    bigint,
  switch_at_bps  int NOT NULL DEFAULT 9500 CHECK (switch_at_bps BETWEEN 1 AND 10000), -- 95% по умолчанию
  fee_bps        int NOT NULL DEFAULT 0 CHECK (fee_bps >= 0),                          -- комиссия в б.п. (250 = 2.5%)
  priority       int NOT NULL DEFAULT 0,
  cap_timezone   text NOT NULL DEFAULT 'UTC',          -- в чьём часовом поясе обнуляется дневной лимит
  credentials_ref text,                                -- ссылка на секрет в хранилище, НЕ сам ключ
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (max_amount >= min_amount),
  CHECK (monthly_cap IS NULL OR monthly_cap >= daily_cap)
);
CREATE INDEX merchant_accounts_operator_idx ON merchant_accounts (operator_id) WHERE enabled;

-- Оборот аккаунта по дням. Строка блокируется (SELECT ... FOR UPDATE) при резервировании лимита,
-- поэтому параллельные платежи не могут переполнить аккаунт.
CREATE TABLE account_usage (
  merchant_account_id uuid NOT NULL REFERENCES merchant_accounts(id),
  day                 date NOT NULL,
  used                bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  reserved            bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (merchant_account_id, day)
);

-- Игрок, как его видит сайт. Лимиты игрока — это ответственная игра: превышение = отказ, не перекидывание.
CREATE TYPE kyc_status AS ENUM ('none', 'pending', 'verified', 'rejected');
CREATE TABLE players (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id              uuid NOT NULL REFERENCES sites(id),
  external_id          text NOT NULL,                 -- ID игрока на стороне сайта
  country              char(2) NOT NULL,
  kyc                  kyc_status NOT NULL DEFAULT 'none',
  deposit_limit_daily  bigint,
  self_excluded        boolean NOT NULL DEFAULT false,
  sticky_account_id    uuid REFERENCES merchant_accounts(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, external_id)
);

-- Платёж (депозит или выплата) — то, что видит сайт.
CREATE TYPE tx_type AS ENUM ('deposit', 'payout');
CREATE TYPE tx_status AS ENUM ('created', 'pending', 'success', 'declined', 'failed');
CREATE TABLE transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES sites(id),
  player_id           uuid NOT NULL REFERENCES players(id),
  type                tx_type NOT NULL,
  amount              bigint NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL,
  status              tx_status NOT NULL DEFAULT 'created',
  merchant_account_id uuid REFERENCES merchant_accounts(id),
  decline_code        text,
  idempotency_key     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, idempotency_key)                   -- повторный запрос не создаёт второй платёж
);
CREATE INDEX transactions_player_idx ON transactions (player_id, created_at DESC);
CREATE INDEX transactions_account_idx ON transactions (merchant_account_id, created_at DESC);

-- Каждая попытка провести платёж через конкретный аккаунт (для каскада и разборов).
CREATE TABLE transaction_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES transactions(id),
  merchant_account_id uuid NOT NULL REFERENCES merchant_accounts(id),
  status              tx_status NOT NULL,
  provider_ref        text,
  route_reason        text NOT NULL,                  -- почему роутер выбрал этот аккаунт
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_attempts_tx_idx ON transaction_attempts (transaction_id);

-- Журнал проводок (двойная запись). Только INSERT: записи никогда не меняются и не удаляются.
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  transaction_id  uuid NOT NULL REFERENCES transactions(id),
  account         text NOT NULL,                      -- 'merchant:<id>', 'player:<id>', 'fees:<id>'
  amount          bigint NOT NULL,                    -- + дебет, - кредит; сумма по транзакции = 0
  currency        char(3) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account, created_at);

CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries: записи журнала нельзя изменять или удалять';
END $$;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();
