-- Отправленные уведомления (Telegram и др.): по ключу события, чтобы не слать одно и то же дважды.
CREATE TABLE notifications_sent (
  key      text PRIMARY KEY,           -- 'issue:42', 'delivery:17', 'acc_full:<id>:2026-11-12', 'prov_err:<id>:2026-11-12T09'
  channel  text NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now()
);
