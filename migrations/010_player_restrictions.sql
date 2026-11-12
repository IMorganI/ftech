-- Ограничения игрока (ответственная игра) больше не перезаписываются каждым депозитом.
--  * Самоисключение «залипает»: депозит может только включить его; снять — отдельным запросом API с записью в журнал.
--  * Дневной лимит: снижение действует сразу, повышение и снятие — после периода охлаждения (по умолчанию 24 ч).
--  * KYC меняется, только если сайт явно его прислал.

ALTER TABLE players ADD COLUMN self_excluded_at timestamptz;
ALTER TABLE players ADD COLUMN deposit_limit_pending_set boolean NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN deposit_limit_pending bigint CHECK (deposit_limit_pending IS NULL OR deposit_limit_pending > 0);
ALTER TABLE players ADD COLUMN deposit_limit_pending_at timestamptz;
ALTER TABLE players ADD COLUMN restrictions_version int NOT NULL DEFAULT 1;
UPDATE players SET self_excluded_at = updated_at WHERE self_excluded;

ALTER TABLE operators ADD COLUMN limit_increase_delay_hours int NOT NULL DEFAULT 24
  CHECK (limit_increase_delay_hours BETWEEN 0 AND 720);

-- Журнал изменений ограничений игрока: что, кто (источник), когда. Только добавление.
CREATE TABLE player_restriction_events (
  id          bigserial PRIMARY KEY,
  player_id   uuid NOT NULL REFERENCES players(id),
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  source      text NOT NULL CHECK (source IN ('deposit', 'payout', 'api', 'system')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_restriction_events_player_idx ON player_restriction_events (player_id, created_at DESC);
CREATE FUNCTION player_restriction_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'player_restriction_events: записи не меняются и не удаляются';
END $$;
CREATE TRIGGER player_restriction_events_immutable BEFORE UPDATE OR DELETE ON player_restriction_events
  FOR EACH ROW EXECUTE FUNCTION player_restriction_events_immutable();
