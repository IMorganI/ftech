-- Настройки роутинга на уровне оператора и данные для идемпотентности и каскада.

-- Выше этой суммы (в минорных единицах) депозит без подтверждённого KYC отклоняется. NULL = без порога.
ALTER TABLE operators ADD COLUMN kyc_required_above bigint CHECK (kyc_required_above IS NULL OR kyc_required_above >= 0);
-- Сколько аккаунтов максимум пробуем для одного платежа (каскад при отказах провайдеров).
ALTER TABLE operators ADD COLUMN max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10);

-- Отпечаток параметров запроса: тот же ключ идемпотентности с другими параметрами = ошибка, а не тихий повтор.
ALTER TABLE transactions ADD COLUMN request_hash text NOT NULL DEFAULT '';

-- Номер попытки и день, на который зарезервирован оборот (в часовом поясе аккаунта).
ALTER TABLE transaction_attempts ADD COLUMN attempt_no int NOT NULL DEFAULT 1;
ALTER TABLE transaction_attempts ADD COLUMN usage_day date;
CREATE UNIQUE INDEX transaction_attempts_no_idx ON transaction_attempts (transaction_id, attempt_no);

-- Быстрый подсчёт дневных депозитов игрока.
CREATE INDEX transactions_player_daily_idx ON transactions (player_id, type, created_at) WHERE status IN ('pending', 'success');
