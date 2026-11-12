-- Ключи провайдеров хранятся у аккаунта в зашифрованном виде (AES-256-GCM, ключ ENCRYPTION_KEY).
-- Если credentials_enc пусто — по-старому берётся секрет по credentials_ref из окружения.
ALTER TABLE merchant_accounts ADD COLUMN credentials_enc text;

-- Результат последней проверки подключения из борды.
ALTER TABLE merchant_accounts ADD COLUMN last_check_at timestamptz;
ALTER TABLE merchant_accounts ADD COLUMN last_check_ok boolean;
ALTER TABLE merchant_accounts ADD COLUMN last_check jsonb;
