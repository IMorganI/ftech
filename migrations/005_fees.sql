-- Комиссии: сколько платформа зарабатывает и сколько стоят провайдеры.

-- Комиссия платформы с оператора за каждый успешный депозит, в базисных пунктах (150 = 1.5%).
ALTER TABLE operators ADD COLUMN platform_fee_bps int NOT NULL DEFAULT 0 CHECK (platform_fee_bps BETWEEN 0 AND 10000);

-- Снимок комиссий на момент успешного платежа: последующая смена процентов не переписывает историю.
ALTER TABLE transactions ADD COLUMN platform_fee bigint;
ALTER TABLE transactions ADD COLUMN provider_fee bigint;

-- Уже успешные платежи: считаем по текущим настройкам.
UPDATE transactions t SET
  platform_fee = t.amount * o.platform_fee_bps / 10000,
  provider_fee = t.amount * m.fee_bps / 10000
FROM sites s, operators o, merchant_accounts m
WHERE t.status = 'success' AND s.id = t.site_id AND o.id = s.operator_id AND m.id = t.merchant_account_id;

CREATE INDEX transactions_stats_idx ON transactions (created_at, status) WHERE type = 'deposit';
