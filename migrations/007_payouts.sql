-- Выплаты игрокам (closed loop).
-- Выплата раскладывается на части: сначала возвраты на карты, с которых были депозиты (в пределах
-- ещё не возвращённого), остаток — ручная выплата, которую оператор делает сам и отмечает в борде.

-- Требовать подтверждённый KYC для выплат (по умолчанию да).
ALTER TABLE operators ADD COLUMN payout_kyc_required boolean NOT NULL DEFAULT true;

-- Сколько из депозита уже возвращено (или зарезервировано под возврат). Не может превысить сумму депозита.
ALTER TABLE transactions ADD COLUMN refunded_amount bigint NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD CONSTRAINT transactions_refunded_le_amount CHECK (refunded_amount >= 0 AND refunded_amount <= amount);

CREATE TYPE payout_leg_kind AS ENUM ('refund', 'manual');
CREATE TYPE payout_leg_status AS ENUM ('pending', 'success', 'failed');

CREATE TABLE payout_legs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id            uuid NOT NULL REFERENCES transactions(id),
  kind                 payout_leg_kind NOT NULL,
  deposit_id           uuid REFERENCES transactions(id),          -- для возврата: какой депозит возвращаем
  merchant_account_id  uuid REFERENCES merchant_accounts(id),     -- для возврата: через какой аккаунт
  amount               bigint NOT NULL CHECK (amount > 0),
  status               payout_leg_status NOT NULL DEFAULT 'pending',
  provider_ref         text,                                       -- ID возврата у провайдера
  error                text,
  note                 text,                                       -- для ручной: что сделал оператор
  completed_by         uuid REFERENCES admin_users(id),
  submitted_at         timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'refund') = (deposit_id IS NOT NULL))
);
CREATE INDEX payout_legs_payout_idx ON payout_legs (payout_id);
CREATE INDEX payout_legs_manual_idx ON payout_legs (created_at) WHERE kind = 'manual' AND status = 'pending';
CREATE INDEX transactions_refundable_idx ON transactions (player_id, created_at DESC)
  WHERE type = 'deposit' AND status = 'success' AND refunded_amount < amount;
