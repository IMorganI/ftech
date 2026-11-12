#!/usr/bin/env bash
# Выкладка версии на этот сервер. Вызывается из GitHub Actions по SSH: deploy.sh <тег образа>
# Вручную: /opt/ftech/deploy/deploy.sh <тег>   Откат — тот же скрипт с прошлым тегом.
set -euo pipefail
TAG="${1:?укажи тег образа (коммит)}"
[[ "$TAG" =~ ^[a-zA-Z0-9._-]{1,128}$ ]] || { echo "Неверный тег"; exit 1; }
cd /opt/ftech
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${TAG}/" .env
docker compose --env-file .env pull --quiet migrate app
# Перед миграциями — свежий бэкап: если что-то пойдёт не так, есть точка восстановления.
/opt/ftech/deploy/backup.sh || { echo "Бэкап не удался — выкладка остановлена"; exit 1; }
docker compose --env-file .env up -d --remove-orphans
for _ in $(seq 1 60); do
  if docker compose --env-file .env exec -T app node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Выложено: $TAG"; docker image prune -f >/dev/null; exit 0
  fi
  sleep 2
done
echo "Новая версия не стала готовой за 2 минуты — смотри: docker compose logs app migrate"; exit 1
