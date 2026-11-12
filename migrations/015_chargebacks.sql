-- Чарджбэки: игрок оспорил оплату через свой банк. Эквайер обычно сразу списывает сумму (и комиссию)
-- с мерчанта; если оператор выиграл спор — возвращает.
--  * charged_back_amount у депозита: оспоренная часть не может быть возвращена игроку выплатой
--    (иначе игрок получит деньги дважды: через банк и через нас);
--  * проводки: при открытии merchant − / chargeback_hold +; выиграли — обратно; проиграли или приняли —
--    chargeback_hold − / chargeback_loss +; комиссия — merchant − / provider_fees +.
ALTER TABLE transactions ADD COLUMN charged_back_amount bigint NOT NULL DEFAULT 0;
ALTER TABLE transactions DROP CONSTRAINT transactions_refunded_le_amount;
ALTER TABLE transactions ADD CONSTRAINT transactions_refunded_le_amount
  CHECK (refunded_amount >= 0 AND charged_back_amount >= 0 AND refunded_amount + charged_back_amount <= amount);

CREATE TYPE chargeback_status AS ENUM ('open', 'evidence_submitted', 'won', 'lost', 'accepted');

CREATE TABLE chargebacks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES transactions(id),
  merchant_account_id uuid NOT NULL REFERENCES merchant_accounts(id),
  case_ref            text,                         -- ID спора у провайдера
  reason_code         text,                         -- код причины платёжной системы (например, 10.4, 4837)
  reason              text,
  amount              bigint NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL,
  fee                 bigint NOT NULL DEFAULT 0 CHECK (fee >= 0),
  status              chargeback_status NOT NULL DEFAULT 'open',
  respond_by          date,                         -- до какого дня ответить провайдеру
  source              text NOT NULL CHECK (source IN ('manual', 'report')),
  created_by          uuid REFERENCES admin_users(id),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);
CREATE UNIQUE INDEX chargebacks_case_idx ON chargebacks (merchant_account_id, case_ref) WHERE case_ref IS NOT NULL;
CREATE INDEX chargebacks_open_idx ON chargebacks (respond_by) WHERE status IN ('open', 'evidence_submitted');

CREATE TABLE chargeback_events (
  id             bigserial PRIMARY KEY,
  chargeback_id  uuid NOT NULL REFERENCES chargebacks(id),
  status         chargeback_status NOT NULL,
  note           text,
  admin_user_id  uuid REFERENCES admin_users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
