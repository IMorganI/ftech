#!/usr/bin/env bash
# npm run up — обновить и (пере)запустить демо-стенд одной командой.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Нет файла .env — сначала дождись первичной настройки Codespace (DEMO-CREDENTIALS.md)."; exit 1; }
set -a; . ./.env; set +a
PORT="${PORT:-3000}"
health() { curl -fs --max-time 2 "localhost:${PORT}/health" >/dev/null 2>&1; }

echo "1/4 Обновляю код…"
LOCK_BEFORE=$(sha1sum package-lock.json 2>/dev/null)
git pull --ff-only -q || echo "    git pull не удался (есть свои изменения?) — запускаю текущую версию"
if [ "$LOCK_BEFORE" != "$(sha1sum package-lock.json 2>/dev/null)" ] || [ ! -d node_modules ]; then
  echo "    зависимости изменились — устанавливаю"; npm ci --ignore-scripts --silent
fi

echo "2/4 Останавливаю старый сервер…"
pkill -f "tsx src/index.ts" 2>/dev/null
for _ in $(seq 1 30); do
  if ! pgrep -f "tsx src/index.ts" >/dev/null && ! health; then break; fi
  sleep 0.5
done

echo "3/4 Запускаю…"
setsid nohup bash .devcontainer/start.sh --foreground > /tmp/ftech.log 2>&1 < /dev/null &
for _ in $(seq 1 60); do health && break; sleep 0.5; done

if health; then
  echo "4/4 Готово ✅  Сервер работает в фоне, лог: /tmp/ftech.log"
  echo
  echo "    Борда: ${PUBLIC_BASE_URL}/admin"
  echo "    Если не открывается: вкладка Ports → порт ${PORT} → правый клик → Видимость порта → Public"
else
  echo "4/4 Сервер не запустился ❌  Последние строки лога:"
  tail -20 /tmp/ftech.log
  exit 1
fi
