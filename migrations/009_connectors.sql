-- Карточки провайдеров: адрес вебхука есть у аккаунта сразу после создания, плюс журнал входящих вебхуков.

-- Токен в адресе вебхука (/v1/provider-webhooks/<id>?token=…). Не даёт доступа к деньгам: статус платежа
-- всё равно перепроверяется запросом к провайдеру. Защищает адрес от мусора и помогает отличить «чужой» адрес.
ALTER TABLE merchant_accounts ADD COLUMN webhook_token text;

-- Каждая попытка провайдера достучаться до нас: принята, повтор, отклонена (и почему), ошибка.
-- Нужна, когда провайдер говорит «мы отправили», а платёж не обновился.
CREATE TABLE provider_webhook_log (
  id                  bigserial PRIMARY KEY,
  merchant_account_id uuid NOT NULL REFERENCES merchant_accounts(id),
  received_at         timestamptz NOT NULL DEFAULT now(),
  method              text NOT NULL,
  outcome             text NOT NULL CHECK (outcome IN ('accepted', 'test', 'duplicate', 'rejected', 'error', 'challenge')),
  reason              text,
  event_id            text,
  provider_ref        text,
  ip                  text
);
CREATE INDEX provider_webhook_log_account_idx ON provider_webhook_log (merchant_account_id, received_at DESC);
