-- Админка: пользователи, сессии, журнал аудита.

CREATE TYPE admin_role AS ENUM ('viewer', 'operator', 'admin');

-- Публичной регистрации нет: первого админа создаёт команда npm run admin:create,
-- остальных — админ через API. Новый пользователь обязан сменить временный пароль и включить 2FA.
CREATE TABLE admin_users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash         text NOT NULL,                 -- scrypt с солью
  must_change_password  boolean NOT NULL DEFAULT true,
  role                  admin_role NOT NULL DEFAULT 'viewer',
  totp_secret_enc       text,                          -- секрет 2FA, зашифрован ENCRYPTION_KEY
  totp_enabled          boolean NOT NULL DEFAULT false,
  totp_last_step        bigint,                        -- последний использованный код нельзя ввести повторно
  failed_logins         int NOT NULL DEFAULT 0,
  locked_until          timestamptz,                   -- блокировка после серии неверных паролей
  disabled              boolean NOT NULL DEFAULT false,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Сессия: в браузере — только случайный токен в HttpOnly-cookie, в базе — его хэш.
CREATE TABLE admin_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES admin_users(id),
  mfa_passed    boolean NOT NULL DEFAULT false,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked       boolean NOT NULL DEFAULT false
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions (user_id) WHERE NOT revoked;

-- Журнал аудита: кто, когда, что сделал, что было и что стало. Только добавление.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  admin_user_id  uuid REFERENCES admin_users(id),
  action         text NOT NULL,                        -- 'account.update', 'site.rotate_key', 'auth.login' …
  entity         text,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log: записи журнала аудита нельзя изменять или удалять';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Кто и когда закрыл расхождение.
ALTER TABLE reconciliation_issues ADD COLUMN resolved_by uuid REFERENCES admin_users(id);
ALTER TABLE reconciliation_issues ADD COLUMN resolved_at timestamptz;
ALTER TABLE reconciliation_issues ADD COLUMN resolution_note text;
