# Админка: доступ и API

## Первый вход

```bash
npm run admin:create -- you@company.com admin     # печатает временный пароль один раз
```

1. `POST /admin/v1/auth/login` `{ email, password }` → `{ next: "totp_setup", totpSecret, otpauthUrl }`.
   Добавь секрет в Google Authenticator / 1Password / Authy (или QR из `otpauthUrl`).
2. `POST /admin/v1/auth/totp` `{ code }` — 6 цифр из приложения → `{ next: "change_password" }`.
3. `POST /admin/v1/me/password` `{ currentPassword, newPassword }` — минимум 12 символов, буквы и цифры.

Дальше каждый вход: пароль → код из приложения. Публичной регистрации нет.

## Защита

| Что | Как |
|---|---|
| Пароли | scrypt с солью, временный пароль обязательно меняется при первом входе |
| 2FA | Обязательна для всех (TOTP, RFC 6238); один код нельзя использовать дважды |
| Перебор | 10 попыток входа в минуту с IP; 5 неверных паролей или кодов — блокировка на 15 минут |
| Сессия | Случайный токен в HttpOnly-cookie (`SameSite=Strict`, `Secure` по HTTPS), в базе только хэш; новый токен после 2FA; 12 ч максимум, 30 мин бездействия |
| CSRF | Изменяющие запросы принимаются только с `Content-Type: application/json` |
| Утечки | Ключи сайтов и секреты показываются один раз, в списки и журнал не попадают |
| Аудит | Каждое изменение и вход — в `audit_log` с «до/после», записи нельзя изменить или удалить |

Смена пароля закрывает остальные сессии пользователя; блокировка, смена роли или сброс 2FA — все его сессии.

## Роли

| | viewer | operator | admin |
|---|:-:|:-:|:-:|
| Смотреть аккаунты, платежи, расхождения, сводку | ✓ | ✓ | ✓ |
| Вкл/выкл аккаунт, лимиты, порог, комиссия, приоритет | | ✓ | ✓ |
| Закрывать расхождения | | ✓ | ✓ |
| Создавать аккаунты, менять валюты/страны/суммы/секреты | | | ✓ |
| Операторы, сайты, ключи, провайдеры | | | ✓ |
| Пользователи админки, журнал аудита | | | ✓ |

## Эндпоинты

Все под `/admin/v1`, суммы — строки в центах.

| Метод | Путь | Роль |
|---|---|---|
| GET | `/overview` — платежи и оборот за 24 ч, ожидающие, расхождения, недоставленные вебхуки | viewer |
| GET/POST | `/operators`, PATCH `/operators/:id` | viewer / admin |
| GET/POST | `/sites` (POST отдаёт `apiKey` и `webhookSecret` один раз), PATCH `/sites/:id` | viewer / admin |
| POST | `/sites/:id/rotate-key`, `/sites/:id/rotate-webhook-secret` | admin |
| GET/POST | `/providers` | viewer / admin |
| GET | `/accounts` — с оборотом за сегодня (`used_today`, `reserved_today`) | viewer |
| POST | `/accounts` | admin |
| PATCH | `/accounts/:id` — оперативные поля operator, структурные только admin | operator |
| GET | `/transactions?status=&siteId=&accountId=&player=&before=&limit=` | viewer |
| GET | `/transactions/:id` — попытки с причинами выбора, проводки, вебхуки | viewer |
| GET | `/issues?all=true`, POST `/issues/:id/resolve` `{ note }` | viewer / operator |
| GET/POST | `/users`, PATCH `/users/:id`, POST `/users/:id/reset-2fa` | admin |
| GET | `/audit?entity=&entityId=&beforeId=&limit=` | admin |
