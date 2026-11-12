-- Распределение трафика между аккаунтами.
--  tier: primary — основные; reserve — резерв, получает платежи, только когда ни один основной не подходит
--        (заполнен лимит, не та сумма и т. п.).
--  weight: доля оборота среди аккаунтов одного уровня и приоритета (60/30/10). Роутер выравнивает
--          фактический дневной оборот к этим долям — ровный поток вместо «заполнить один, потом следующий».
ALTER TABLE merchant_accounts ADD COLUMN tier text NOT NULL DEFAULT 'primary' CHECK (tier IN ('primary', 'reserve'));
ALTER TABLE merchant_accounts ADD COLUMN weight int NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 10000);

-- Подробности отказа для сайта: например, сколько можно принять сейчас (capacity_exhausted).
ALTER TABLE transactions ADD COLUMN decline_details jsonb;

-- Как оператор распределяет трафик: fill — по порядку (приоритет → дешевле комиссия → больше свободного лимита,
-- следующий аккаунт — когда предыдущий заполнен; как было), weights — по весам аккаунтов.
ALTER TABLE operators ADD COLUMN routing_mode text NOT NULL DEFAULT 'fill' CHECK (routing_mode IN ('fill', 'weights'));
