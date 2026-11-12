#!/usr/bin/env bash
# Проверка, что бэкап действительно восстанавливается: берёт последний бэкап (из хранилища, если задано),
# расшифровывает, поднимает временную базу, восстанавливает и проверяет данные. Боевую базу не трогает.
# Запуск: раз в неделю из cron; результат — в Telegram (если настроен).
set -euo pipefail
cd /opt/ftech
set -a; . ./.env; set +a
WORK=$(mktemp -d); trap 'docker rm -f ftech-restore-check >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && \
    curl -fs -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" >/dev/null || true
  echo "$1"
}
fail() { notify "❌ Проверка бэкапа ftech не прошла: $1"; exit 1; }

if [ -n "${BACKUP_REMOTE:-}" ]; then
  LATEST=$(rclone lsf "$BACKUP_REMOTE" --include 'ftech-*.dump.enc' | sort | tail -1)
  [ -n "$LATEST" ] || fail "в хранилище нет бэкапов"
  rclone copy "$BACKUP_REMOTE/$LATEST" "$WORK" --quiet
else
  LATEST=$(ls -1 /opt/ftech/backups/ftech-*.dump.enc 2>/dev/null | sort | tail -1 | xargs -r basename)
  [ -n "$LATEST" ] || fail "нет локальных бэкапов"
  cp "/opt/ftech/backups/$LATEST" "$WORK/"
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$WORK/$LATEST" -out "$WORK/db.dump" \
  || fail "не расшифровывается ($LATEST)"

docker run -d --name ftech-restore-check -e POSTGRES_PASSWORD=check -e POSTGRES_USER=ftech -e POSTGRES_DB=ftech postgres:16.6 >/dev/null
for _ in $(seq 1 60); do docker exec ftech-restore-check pg_isready -U ftech -d ftech >/dev/null 2>&1 && break; sleep 1; done
docker exec -i ftech-restore-check pg_restore -U ftech -d ftech --no-owner < "$WORK/db.dump" || fail "pg_restore с ошибкой ($LATEST)"

q() { docker exec ftech-restore-check psql -U ftech -d ftech -Atc "$1"; }
MIG=$(q "SELECT max(name) FROM schema_migrations") || fail "нет таблицы миграций"
TX=$(q "SELECT count(*) FROM transactions")
UNBAL=$(q "SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount) <> 0) x")
[ "$UNBAL" = "0" ] || fail "в восстановленной базе $UNBAL платежей с несходящимися проводками"
notify "✅ Бэкап ftech восстанавливается: $LATEST · миграция $MIG · платежей $TX · проводки сходятся"
