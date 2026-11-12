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

## 2. Подключение в борде

Борда → **Подключения** → оператор → **+ Подключить платёжный аккаунт** → провайдер **Viva Wallet (Smart Checkout)**,
валюта, страны, лимиты → **Создать и перейти к ключам**.

1. **Ключи** — впиши Client ID, Client Secret, Merchant ID, API Key (и при желании код источника) →
   **Сохранить ключи**. Ключи шифруются в базе (`ENCRYPTION_KEY`); после сохранения видны только последние
   4 символа секретов. В журнал аудита пишется только, какие поля менялись. Терминал и `.env` не нужны.
2. **Проверка** — кнопка **Проверить подключение**: без создания платежей проверяет, что Viva принимает
   Client ID/Secret, что это ключи именно от Smart Checkout, и что работают Merchant ID/API Key.
   Ошибки — понятным текстом (например, «ключи от POS, нужны Smart Checkout Credentials»).

Старый способ — секрет `PROVIDER_SECRET_<REF>` в окружении и `credentials_ref` у аккаунта — продолжает
работать; если ключи введены в борде, используются они.

## 3. Вебхуки (мгновенное подтверждение оплаты)

В карточке аккаунта, в шаге **3. Вебхук у провайдера**, — готовый адрес с токеном и кнопка «Копировать».
Вставь его в кабинете Viva (**Settings → API Access → Webhooks → Create Webhook**), события
**Transaction Payment Created** и **Transaction Failed**, нажми **Verify** и проверь, что статус **Active**.

Если сервер доступен провайдеру не по `PUBLIC_BASE_URL` (например, в Codespaces через туннель Cloudflare),
задай `WEBHOOK_BASE_URL=https://…trycloudflare.com` в `.env` — борда покажет адрес с ним.

## Подробнее про вебхуки

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

## Возвраты и баланс

Viva делает возвраты **из доступного баланса** мерчанта. Пока оплаты не прошли клиринг (или если
баланс выведен в банк), возврат отклоняется с `PaymentsInsufficientFundsForReversal` — тогда эта
часть выплаты автоматически становится ручной. Поэтому оператору стоит держать на Viva запас под
выплаты. Успехом возврата считается только ответ с `Success = true` и `ErrorCode = 0`.

## 4. Проверка

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
| Возврат (для выплат) | `DELETE {www}/api/transactions/<TransactionId>/?amount=<центы>&sourceCode=…`, Basic → `Success`, `StatusId` F/E, `ErrorText` (например `PaymentsInvalidAmountForVoid` — больше остатка) |
| Ключ вебхука | `GET {www}/api/messages/config/token`, Basic merchantId:apiKey → `{ Key }` |

Хосты demo: `demo-accounts.vivapayments.com`, `demo-api.vivapayments.com`, `demo.vivapayments.com`;
live: `accounts.vivapayments.com`, `api.vivapayments.com`, `www.vivapayments.com`.

Ответы Viva: 4xx при создании — отказ (платёж уйдёт на следующий аккаунт), 5xx/таймаут —
неизвестно, создан ли заказ, поэтому попытка ждёт сверки, а не дублируется.

**Важно для боевого режима:** уточни у Viva, обслуживают ли они гемблинг под твою лицензию
и в каких странах. Без их одобрения боевой аккаунт могут заблокировать.
