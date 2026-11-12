# Продакшн: сервер, домен, выкладка, бэкапы

Схема: **на каждую среду — свой сервер** (staging для проверок, production для реальных денег).
На сервере в Docker: **Caddy** (HTTPS-сертификат выпускается сам) → **приложение** → **PostgreSQL**.
Код выкладывается из GitHub: после мерджа в `main` — автоматически на staging, на production — по кнопке
с подтверждением. Перед каждой выкладкой делается бэкап базы.

Что понадобится: аккаунт у хостинга (ниже — Hetzner Cloud), домен, ~30–40 минут на первую настройку.

---

## 1. Ключ SSH для выкладки

На своём компьютере (Terminal на Mac):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ftech_deploy -C deploy -N ""
cat ~/.ssh/ftech_deploy.pub     # публичный — пойдёт на сервер
```

Приватный ключ `~/.ssh/ftech_deploy` никому не отправляй — только в секреты GitHub (шаг 6).

## 2. Сервер

Hetzner Cloud → **Add Server**:
- Location: **Falkenstein / Nuremberg / Helsinki** (ЕС);
- Image: **Ubuntu 24.04**;
- Type: **CX22** (2 vCPU, 4 ГБ) — достаточно для старта; staging — такой же или меньше;
- SSH key: добавь публичный ключ из шага 1;
- **Cloud config**: вставь содержимое `deploy/cloud-init.yaml`, заменив строку `ssh-ed25519 AAAA...` на свой
  публичный ключ.

Сервер сам: создаст пользователя `deploy` (вход только по ключу, root и пароли запрещены), включит файрвол
(22, 80, 443), fail2ban, автоматические обновления безопасности, поставит Docker и rclone, заведёт расписание
бэкапов. Через 3–5 минут проверь вход:

```bash
ssh -i ~/.ssh/ftech_deploy deploy@IP_СЕРВЕРА
```

## 3. Домен

У регистратора домена добавь **A-запись**: `pay.твойдомен.com` → IP сервера (для staging —
`staging.твойдомен.com` → IP второго сервера). Подожди, пока запись начнёт работать (обычно минуты).

## 4. Настройки на сервере

```bash
ssh -i ~/.ssh/ftech_deploy deploy@IP_СЕРВЕРА
cd /opt/ftech
nano .env          # вставь содержимое deploy/env.example и заполни
chmod 600 .env
```

Обязательно заполнить:

| Переменная | Как получить |
|---|---|
| `DOMAIN`, `PUBLIC_BASE_URL` | Твой домен: `pay.example.com` и `https://pay.example.com` |
| `ACME_EMAIL` | Почта для Let's Encrypt (уведомления о сертификате) |
| `DB_PASSWORD` | `openssl rand -hex 24` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` — **сохрани копию в менеджере паролей**: без него ключи провайдеров в базе не прочитать |
| `BACKUP_PASSPHRASE` | `openssl rand -hex 32` — **тоже сохрани**: без него бэкапы не расшифровать |

`MOCK_PROVIDER_ENABLED` оставь `false`: на боевом сервере учебные провайдеры запрещены (сервер не запустится).

## 5. Хранилище для бэкапов

Бэкап должен лежать **не на том же сервере**. Hetzner → **Object Storage** → создай бакет
(например, `ftech-backups`) и ключи доступа. На сервере:

```bash
rclone config      # n → имя: backup → тип: s3 → провайдер: Other →
                   # access key / secret key → endpoint: fsn1.your-objectstorage.com (из консоли Hetzner)
rclone lsd backup: # проверка — должен показать бакет
```

В `.env`: `BACKUP_REMOTE=backup:ftech-backups/prod` (для staging — `.../staging`).

## 6. GitHub: выкладка

**Settings → Environments**:
- создай **staging** и **production**;
- в **production** включи **Required reviewers** (себя) — выкладка на прод только после твоего подтверждения;
- в каждом окружении — **Environment secrets**:

| Секрет | Значение |
|---|---|
| `DEPLOY_HOST` | IP сервера этого окружения |
| `DEPLOY_SSH_KEY` | Содержимое **приватного** ключа `~/.ssh/ftech_deploy` |
| `DEPLOY_KNOWN_HOSTS` | Вывод `ssh-keyscan -t ed25519 IP_СЕРВЕРА` (защита от подмены сервера) |

**Settings → Secrets and variables → Actions → Variables**: `DEPLOY_ENABLED` = `true`.

Образ публикуется в GitHub Container Registry (`ghcr.io/imorgani/ftech`). Чтобы сервер мог его скачать без
пароля: после первой сборки **Packages → ftech → Package settings → Change visibility → Public**
(код и так открыт; секретов в образе нет). Если пакет оставляешь закрытым — на сервере один раз:
`docker login ghcr.io -u <github-логин>` с токеном, у которого есть право `read:packages`.

## 7. Первая выкладка

- **staging**: смерджи любой PR в `main` (или Actions → Deploy → Run workflow → staging).
- **production**: Actions → **Deploy** → **Run workflow** → `production` → подтверди.

Что происходит: собирается образ → на сервер копируются конфиги → бэкап базы → скачивание образа →
миграции → новая версия → проверка `/ready`. Если версия не поднялась за 2 минуты — выкладка красная,
старые данные не тронуты.

Первый администратор — на сервере:

```bash
cd /opt/ftech && docker compose exec app node dist/admin/create-user.js you@company.com admin
```

Открой `https://pay.твойдомен.com/admin`, настрой 2FA и смени пароль.

## 8. Мониторинг

- **Встроенный**: Actions → **Uptime** каждые 10 минут проверяет `/ready` и пишет в Telegram, если сервер не
  отвечает. Включить: переменная `UPTIME_URLS` = `https://pay.твойдомен.com https://staging.твойдомен.com`,
  секреты репозитория `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`.
- **Точнее и быстрее** (рекомендуется дополнительно): бесплатный внешний мониторинг (UptimeRobot, Better Stack)
  на `https://pay.твойдомен.com/ready` с уведомлением в Telegram.
- **Деньги и платежи** — уведомления самого приложения в Telegram (проблемы, чарджбэки, лимиты, зависшие платежи).

## 9. Обычная работа

| Задача | Как |
|---|---|
| Выложить новую версию | Мердж в `main` → staging сам; прод — Actions → Deploy → production |
| Откатить прод | Actions → Deploy → production, в поле «Тег» — хэш прошлого коммита |
| Логи | `cd /opt/ftech && docker compose logs -f app` |
| Перезапуск | `docker compose restart app` |
| Бэкап вручную | `/opt/ftech/deploy/backup.sh` |
| Проверить бэкап | `/opt/ftech/deploy/restore-check.sh` — восстановит последний бэкап во временную базу и проверит |
| Восстановить базу | См. ниже |

Бэкапы: каждую ночь (03:17 UTC) и перед каждой выкладкой; локально — 7 дней, в хранилище — 30 дней.
Проверка восстановления — каждое воскресенье, результат в Telegram.

### Восстановление базы из бэкапа

```bash
cd /opt/ftech && set -a && . ./.env && set +a
rclone copy backup:ftech-backups/prod/ftech-<время>.dump.enc ./restore/
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in ./restore/ftech-<время>.dump.enc -out ./restore/db.dump
docker compose stop app
docker compose exec -T db pg_restore -U ftech -d ftech --clean --if-exists --no-owner < ./restore/db.dump
docker compose start app && rm -rf ./restore
```

## Что ещё до реальных денег

- Отдельные ключи провайдеров для staging (демо) и production (боевые) — вводятся в борде каждого стенда.
- Адрес вебхука провайдера на проде — постоянный: `https://pay.твойдомен.com/v1/provider-webhooks/...`
  (копируется из борды); вебхуки Viva заработают без туннелей.
- Пройти по чек-листу безопасности: доступы команды и роли, 2FA у всех, копии `ENCRYPTION_KEY` и
  `BACKUP_PASSPHRASE` в надёжном месте, проверка восстановления бэкапа прошла.
