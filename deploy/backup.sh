#!/usr/bin/env bash
# Бэкап базы: дамп → шифрование → локально (7 дней) и во внешнее хранилище (30 дней).
# Запуск: каждую ночь из cron (см. cloud-init.yaml). Вручную: /opt/ftech/deploy/backup.sh
set -euo pipefail
cd /opt/ftech
set -a; . ./.env; set +a
: "${BACKUP_PASSPHRASE:?нет BACKUP_PASSPHRASE в .env}"

DIR=/opt/ftech/backups
mkdir -p "$DIR"; chmod 700 "$DIR"
NAME="ftech-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"

# Формат custom (-Fc): сжатый, восстанавливается выборочно. Дамп не пишется на диск в открытом виде.
docker compose exec -T db pg_dump -U ftech -d ftech -Fc \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$DIR/$NAME"
chmod 600 "$DIR/$NAME"
[ -s "$DIR/$NAME" ] || { echo "Пустой бэкап"; exit 1; }

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$DIR/$NAME" "$BACKUP_REMOTE" --quiet
  rclone delete "$BACKUP_REMOTE" --min-age 30d --quiet || true
fi
find "$DIR" -name 'ftech-*.dump.enc' -mtime +7 -delete
echo "Бэкап готов: $NAME ($(du -h "$DIR/$NAME" | cut -f1))"
