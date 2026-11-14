# Marginly — сервер

Аккаунты по почте, синхронизация данных между устройствами, фото и тарифы.

- **Пробная неделя:** 1 партия, до 10 товаров. Потом подписка 499 ₽/мес, без неё — только просмотр.
- Данные каждого пользователя хранятся отдельно (таблица `docs`: путь → JSON).
- Синхронизация: `POST /api/sync` отправляет изменения устройства и получает всё новое с сервера после `cursor`.
- Фото: `POST /api/blobs`, ссылки подписаны и не угадываются.
- Без `SMTP_HOST` письма с кодами не отправляются, а пишутся в журнал (тестовый режим).

## Запуск

```
pip install -r requirements.txt
uvicorn app.main:app --port 8080
```

Выдать подписку вручную (пока нет оплаты): `python -m app.admin grant user@mail.ru 30`

## Тесты

```
pip install pytest httpx
python -m pytest
```

## Почта для кодов

Письма уходят с `marginly.app@gmail.com` через пароль приложения Google.
На сервере задаются переменные окружения (пароль в репозиторий не кладём):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=marginly.app@gmail.com
SMTP_PASSWORD=<пароль приложения из 16 букв>
MAIL_FROM=Marginly <marginly.app@gmail.com>
```
