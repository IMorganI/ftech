-- Входящие вебхуки провайдеров как полноценный inbox: received → processing → processed.
-- «Повтор» теперь означает «событие уже обработано»; если обработка упала, повторная доставка
-- или фоновая задача обработают событие заново.
ALTER TABLE provider_webhook_events ADD COLUMN processed_at timestamptz;
ALTER TABLE provider_webhook_events ADD COLUMN processing_until timestamptz;
ALTER TABLE provider_webhook_events ADD COLUMN attempts int NOT NULL DEFAULT 0;
ALTER TABLE provider_webhook_events ADD COLUMN last_error text;
UPDATE provider_webhook_events SET processed_at = received_at WHERE result IS NOT NULL;
CREATE INDEX provider_webhook_events_unprocessed_idx ON provider_webhook_events (received_at) WHERE processed_at IS NULL;
