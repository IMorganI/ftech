-- Оборот аккаунта считается отдельно по каждой валюте: минорные единицы разных валют не складываются.
-- Новые аккаунты — одна валюта на аккаунт (проверяется в API); для старых мультивалютных лимит
-- действует в каждой валюте отдельно.
ALTER TABLE account_usage ADD COLUMN currency char(3);
UPDATE account_usage u SET currency = m.currencies[1] FROM merchant_accounts m WHERE m.id = u.merchant_account_id;
ALTER TABLE account_usage ALTER COLUMN currency SET NOT NULL;
ALTER TABLE account_usage DROP CONSTRAINT account_usage_pkey;
ALTER TABLE account_usage ADD PRIMARY KEY (merchant_account_id, day, currency);
