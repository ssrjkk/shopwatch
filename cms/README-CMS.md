# Интеграция OneWatch с OpenCart, WooCommerce и PrestaShop

В папке `cms/` собраны готовые каталоги — **391 позиция** (с реальными фотографиями PiterGSM, артикулами `REF-0001`..`REF-0411`, ценами, скидками и характеристиками) и модули прямой синхронизации заказов с вашими ботами Telegram (`@wwwatchshop_bot`) и MAX (`server.js`).

## 1. WooCommerce (WordPress)
- **Каталог для импорта, 391 позиция:** `cms/woocommerce/watchop-woocommerce-products.csv`
  - В админке WordPress откройте **Товары → Все товары → Импорт**, выберите `watchop-woocommerce-products.csv` — все 391 позиции, бренды, категории и фото PiterGSM загрузятся автоматически.
- **Плагин синхронизации с Telegram и MAX:** `cms/woocommerce/watchop-tg-max-bridge/watchop-tg-max-bridge.php`
  - Скопируйте папку `watchop-tg-max-bridge` в `wp-content/plugins/` и активируйте плагин. Каждый заказ получает код `TG-XXXX`, уходит в `@wwwatchshop_bot` и MAX, а на странице «Спасибо за заказ» выводится кнопка перехода в Telegram.
- **REST API совместимость:** сервер `server.js` также отдаёт каталог в нативном формате WooCommerce REST API v3 по адресу `GET /wp-json/wc/v3/products` и принимает вебхуки WooCommerce на `POST /api/webhooks/woocommerce`.

## 2. OpenCart 3.x / 4.x
- **SQL-дамп каталога, 391 позиция (категории и производители):** `cms/opencart/watchop-opencart-seed.sql`
  - Выполните `mysql -u watchop -p watchop_cms < cms/opencart/watchop-opencart-seed.sql` (или импортируйте через phpMyAdmin) — таблицы `oc_product`, `oc_product_description`, `oc_category`, `oc_manufacturer` и `oc_product_special` заполнятся мгновенно.
- **CSV-таблица для модуля импорта:** `cms/opencart/watchop-opencart-products.csv`
- **Модуль отправки заказов в Telegram/MAX:** `cms/opencart/upload/catalog/controller/extension/module/watchop_tg_max.php` (шлёт вебхук на `POST /api/webhooks/opencart`).

## 3. PrestaShop 8
- **Каталог для импорта, 391 позиция:** `cms/prestashop/watchop-prestashop-products.csv`
  - В панели PrestaShop откройте **Расширенные параметры → Импорт (Advanced Parameters → Import)**, выберите тип `Товары (Products)`, разделитель полей `;` и загрузите файл.
- **Модуль синхронизации заказов:** `cms/prestashop/watchopbridge/watchopbridge.php` (хук `actionValidateOrder` → `POST /api/webhooks/prestashop`).

## 4. Безопасность: секреты вебхуков и запуск стека

- **Подпись вебхуков обязательна.** Сервер принимает заказы только с заголовком
  `X-WATCHOP-SIGNATURE: sha256=<hex>` — HMAC-SHA256 сырого JSON-тела на секрете
  `CMS_WEBHOOK_SECRET` (можно свой на движок: `CMS_WEBHOOK_SECRET_WOOCOMMERCE`,
  `CMS_WEBHOOK_SECRET_OPENCART`, `CMS_WEBHOOK_SECRET_PRESTASHOP`). Без секрета
  приём выключен (сервер отвечает 503), без верной подписи — 401. Тот же секрет
  задайте в плагине CMS как `WATCHOP_WEBHOOK_SECRET` (env) — подпись ставится сама.
- **Повторы не плодят заявки.** Пара (движок + внешний ID заказа) уникальна:
  повторная доставка того же вебхука возвращает исходный код с флагом duplicate.
- **Пароли только из .env.** В `cms/docker-compose.cms.yml` нет значений по умолчанию:
  задайте `CMS_DB_ROOT_PASSWORD`, `CMS_DB_USER`, `CMS_DB_PASSWORD`
  (и при желании `CMS_DB_NAME`, порты `BOT_PORT`/`OPENCART_PORT`/`WOOCOMMERCE_PORT`/`PRESTASHOP_PORT`).
  Без них compose падает с понятной ошибкой — это защита от запуска с публичными паролями.
- **Порты только на localhost.** Панели CMS и бот слушают `127.0.0.1`; наружу их
  открывает обратный прокси (nginx/Caddy) с TLS, а не compose напрямую.
