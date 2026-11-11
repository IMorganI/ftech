#!/usr/bin/env bash
# Запуск сервера. Из postStartCommand — в фоне, вручную (npm run demo) — в этом терминале.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
npm run -s migrate
if [ "${1:-}" = "--foreground" ]; then
  exec npx tsx src/index.ts
fi
if pgrep -f "tsx src/index.ts" >/dev/null; then echo "Сервер уже запущен"; exit 0; fi
setsid nohup npx tsx src/index.ts > /tmp/ftech.log 2>&1 < /dev/null &
echo "Сервер запускается: ${PUBLIC_BASE_URL}/admin (лог: /tmp/ftech.log)"
