#!/usr/bin/env bash
# Первый запуск Codespace: зависимости, .env с новыми ключами, база, демо-данные, первый админ.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  if [ -n "${CODESPACE_NAME:-}" ]; then
    BASE_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  else
    BASE_URL="http://localhost:3000"
  fi
  cat > .env <<ENV
DATABASE_URL=postgres://ftech:ftech@db:5432/ftech
ENCRYPTION_KEY=$(openssl rand -base64 32)
PUBLIC_BASE_URL=${BASE_URL}
PORT=3000
HOST=0.0.0.0
TRUST_PROXY=true
LOG_LEVEL=info
MOCK_PROVIDER_ENABLED=true
PROVIDER_SECRET_MOCK=$(openssl rand -hex 24)
ENV
  echo "Создан .env (ключи сгенерированы для этого Codespace)"
fi

npm ci --ignore-scripts

set -a; . ./.env; set +a

echo "Жду базу…"
for i in $(seq 1 60); do
  node -e "const {Pool}=require('pg');new Pool({connectionString:process.env.DATABASE_URL}).query('select 1').then(()=>process.exit(0),()=>process.exit(1))" && break
  sleep 1
done

npm run -s migrate
SEED=$(npm run -s seed)
ADMIN=$(npm run -s admin:create -- admin@ftech.local admin 2>&1 || true)

API_KEY=$(echo "$SEED" | grep -o 'ftk_[A-Za-z0-9_-]*' || true)
TEMP_PW=$(echo "$ADMIN" | grep -o 'один раз): .*' | sed 's/один раз): //' || true)

if [ -n "$API_KEY" ] && [ -n "$TEMP_PW" ]; then
cat > DEMO-CREDENTIALS.md <<MD
# Доступы к демо-стенду

Этот файл создан только в твоём Codespace и в git не попадает.

**Борда:** ${PUBLIC_BASE_URL}/admin

| | |
|---|---|
| Email | \`admin@ftech.local\` |
| Временный пароль | \`${TEMP_PW}\` |
| API-ключ демо-сайта (для «Песочницы») | \`${API_KEY}\` |

При первом входе борда попросит отсканировать QR-код в Google Authenticator / 1Password / Authy
и сменить временный пароль.

Если борда не открывается — в терминале: \`npm run demo\`.
MD
echo "Готово. Доступы — в файле DEMO-CREDENTIALS.md"
fi
