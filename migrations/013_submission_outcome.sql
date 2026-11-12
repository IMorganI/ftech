-- Чем закончилась отправка попытки провайдеру:
--  created  — провайдер создал платёж (есть provider_ref);
--  declined — провайдер явно отказал (платёж не создан, каскад безопасен);
--  unknown  — ответ потерян (таймаут, 5xx, падение процесса): платёж МОГ быть создан.
-- Для unknown каскад запрещён, пока не подтверждено отсутствие платежа у провайдера
-- или пока не истёк срок, в течение которого заказ провайдера можно оплатить.
ALTER TABLE transaction_attempts ADD COLUMN submit_outcome text CHECK (submit_outcome IN ('created', 'declined', 'unknown'));
UPDATE transaction_attempts SET submit_outcome = 'created' WHERE provider_ref IS NOT NULL;
