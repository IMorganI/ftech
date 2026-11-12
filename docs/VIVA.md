# Подключение Viva Wallet

Адаптер: `src/providers/viva.ts`. Игрок платит на странице Viva **Smart Checkout**, номера карт
к нам не попадают. Статус платежа всегда берётся запросом к Viva, а не из вебхука.

## 1. Что взять в кабинете Viva (demo)

Войди в demo-кабинет Viva (адрес demo-кабинета — в письме о регистрации или на developer.viva.com).

| Что | Где в кабинете | Поле в секрете |
|---|---|---|
| Client ID и Client Secret (Smart Checkout) | Settings → API Access → Smart Checkout Credentials | `clientId`, `clientSecret` |
| Merchant ID и API Key | Settings → API Access | `merchantId`, `apiKey` |
| Код источника платежей (необязательно) | Sales → Online Payments → Websites/Apps | `sourceCode` |

В настройках источника платежей укажи Success URL и Failure URL — куда Viva вернёт игрока
после оплаты (страница твоего сайта).

## 2. Секрет — только в GitHub, не в чат и не в код

Сгенерируй токен для адреса вебхука (в терминале Codespace): `openssl rand -hex 24`.

GitHub → аватарка → **Settings → Codespaces → Secrets → New secret**:

- **Name:** `PROVIDER_SECRET_VIVA`
- **Value** (одной строкой, свои значения):
  ```json
  {"env":"demo","clientId":"…","clientSecret":"…","merchantId":"…","apiKey":"…","sourceCode":"…","currency":"EUR","webhookToken":"…"}
  ```
- **Repository access:** `IMorganI/ftech`

Перезапусти Codespace (github.com/codespaces → … → Stop, потом открыть снова): секреты
подхватываются при старте.

## 3. Провайдер и аккаунт в борде

1. **Настройки → Провайдеры:** название `Viva Wallet`, код `viva`, адаптер `viva`.
2. **Аккаунты → Новый аккаунт:** провайдер Viva Wallet, валюта `EUR`, страны твоей лицензии,
   лимиты, комиссия Viva по твоему договору, ссылка на секрет **`VIVA`**.
3. Чтобы тестовые платежи точно шли через Viva — выключи мок-аккаунты (кнопка «Выключить»).

## 4. Вебхуки (мгновенное подтверждение оплаты)

Без вебхуков платёж всё равно подтвердится: сверка спрашивает Viva сама, но через ~5 минут.

1. В Codespace: вкладка **Ports** → порт 3000 → **Port Visibility → Public** (Viva должна достучаться).
2. В борде скопируй **ID** аккаунта Viva (виден в карточке аккаунта).
3. Кабинет Viva → **Settings → API Access → Webhooks → Create Webhook**:
   - URL: `https://<адрес-codespace>-3000.app.github.dev/v1/provider-webhooks/<ID аккаунта>?token=<webhookToken>`
   - события: **Transaction Payment Created** и **Transaction Failed**
   - нажми **Verify** — Viva запросит адрес, сервер ответит её ключом.

Вебхуки Viva не подписаны, поэтому адрес закрыт секретным токеном, а статус всё равно
перепроверяется запросом к Viva — поддельный «оплачено» ничего не даст. Токен в логи не пишется.

## Частые ошибки

| В попытке платежа | Причина |
|---|---|
| `viva_http_403: нет прав на создание заказа…` | Ключи не из блока **Smart Checkout Credentials** (например, POS/ECR). Проверить: токен должен иметь scope `urn:viva:payments:core:api:redirectcheckout` |
| `viva_http_400: …` | Viva отклонила параметры: сумма, валюта, код источника |
| вебхук `Inactive` в кабинете Viva | Нажми Edit → включи; при включении Viva заново проверяет адрес (порт должен быть Public) |
| Вебхук активен, но POST не приходит | В Codespaces туннель GitHub может не пропускать запросы Viva; платёж всё равно подтвердит сверка через ~1 минуту. На постоянном хостинге этой проблемы нет |

## 5. Проверка

**Тест-платёж** в борде → «Открыть страницу оплаты» → откроется Viva Smart Checkout (demo).
Тестовые карты — в разделе тестирования на developer.viva.com. После оплаты платёж станет
«Успех» во вкладке «Платежи».

## Как адаптер работает с API Viva

| Действие | Запрос |
|---|---|
| Токен | `POST {accounts}/connect/token`, Basic clientId:clientSecret, `grant_type=client_credentials` (кэшируется) |
| Создать оплату | `POST {api}/checkout/v2/orders` `{ amount (центы), customerTrns, merchantTrns: ID попытки, sourceCode }` |
| Страница оплаты | `{www}/web/checkout?ref=<orderCode>` |
| Статус | `GET {www}/api/orders/<orderCode>`, Basic merchantId:apiKey → `StateId` 0 ждёт, 1 истёк, 2 отменён, 3 оплачен |
| Найти оплату заказа | `GET {www}/api/transactions?ordercode=<orderCode>`, Basic → `Transactions[]`, берём `TransactionType.TransactionTypeId = 5` (CardCharge) и `StatusId = F` |
| Возврат (для выплат) | `DELETE {www}/api/transactions/<TransactionId>/?amount=<сумма>&sourceCode=…`, Basic → `Success`, `StatusId` F/E, `ErrorText` (например `PaymentsInvalidAmountForVoid` — больше остатка) |
| Ключ вебхука | `GET {www}/api/messages/config/token`, Basic merchantId:apiKey → `{ Key }` |

Хосты demo: `demo-accounts.vivapayments.com`, `demo-api.vivapayments.com`, `demo.vivapayments.com`;
live: `accounts.vivapayments.com`, `api.vivapayments.com`, `www.vivapayments.com`.

Ответы Viva: 4xx при создании — отказ (платёж уйдёт на следующий аккаунт), 5xx/таймаут —
неизвестно, создан ли заказ, поэтому попытка ждёт сверки, а не дублируется.

**Важно для боевого режима:** уточни у Viva, обслуживают ли они гемблинг под твою лицензию
и в каких странах. Без их одобрения боевой аккаунт могут заблокировать.
