-- Контроль выплат.
--  * withdrawal_id — ID вывода в системе казино. Один вывод = одна выплата, даже если сайт пришлёт
--    его с другим Idempotency-Key (раньше так можно было создать две выплаты).
--  * payout_max_amount — максимальная сумма одной выплаты у оператора (NULL — без ограничения).
--  * manual_approval_above — ручные выплаты от этой суммы требуют одобрения вторым сотрудником
--    (одобряет один, отмечает выполненной другой). NULL — без второго сотрудника.
--  * У ручной выплаты фиксируются: кто одобрил, когда, номер подтверждающей операции (перевода).
ALTER TABLE transactions ADD COLUMN withdrawal_id text;
CREATE UNIQUE INDEX transactions_withdrawal_idx ON transactions (site_id, withdrawal_id) WHERE withdrawal_id IS NOT NULL;

ALTER TABLE operators ADD COLUMN payout_max_amount bigint CHECK (payout_max_amount IS NULL OR payout_max_amount > 0);
ALTER TABLE operators ADD COLUMN manual_approval_above bigint CHECK (manual_approval_above IS NULL OR manual_approval_above >= 0);

ALTER TABLE payout_legs ADD COLUMN approved_by uuid REFERENCES admin_users(id);
ALTER TABLE payout_legs ADD COLUMN approved_at timestamptz;
ALTER TABLE payout_legs ADD COLUMN reference text;
ALTER TABLE payout_legs ADD CONSTRAINT payout_legs_maker_checker CHECK (approved_by IS NULL OR completed_by IS NULL OR approved_by <> completed_by);
