#!/usr/bin/env bash
# Запуск сервера. Codespaces вызывает его при каждом подключении (postAttachCommand) в отдельном терминале;
# вручную: npm run demo. Если сервер уже отвечает — второй не запускается.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

if curl -fs "localhost:${PORT:-3000}/health" >/dev/null 2>&1; then
  echo "Сервер уже работает: ${PUBLIC_BASE_URL}/admin"
  exit 0
fi

npm run -s migrate
echo "Борда: ${PUBLIC_BASE_URL}/admin  (порт 3000 во вкладке Ports; не закрывай этот терминал)"
if [ "${1:-}" = "--foreground" ]; then
  exec npx tsx src/index.ts
fi
setsid nohup npx tsx src/index.ts > /tmp/ftech.log 2>&1 < /dev/null &
echo "Сервер запущен в фоне (лог: /tmp/ftech.log)"
