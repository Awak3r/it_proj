# API

`Authorization: tma <Telegram.WebApp.initData>` — для всех защищённых запросов. `X-Dev-User: <id>` работает **только** с серверным DEV_AUTH=true.

- `GET /api/health` — проверка PostgreSQL.
- `GET /api/config` — только флаг режима разработки, секреты не возвращаются.
- `GET /api/state` — согласованный снимок профиля, доступных событий, записей, ведомостей и справочников. Оценки студентов ограничены своей группой, преподавателей — назначениями; root видит всё.
- `GET /api/updates` — SSE с теми же заголовками авторизации. Событие `change` с `data: {}` означает «перечитать /api/state»; первое подключение и восстановление также дают `change`. `unavailable` включает резервный опрос, пока восстанавливается соединение сервера с PostgreSQL. В потоке нет оценок, имён или идентификаторов пользователей.
- `POST /api/command` — JSON-команда + уникальный заголовок `Idempotency-Key` (8–128 символов). Повторяйте неопределённо завершившийся запрос с тем же ключом и телом.

Основные команды:

| kind | Поля |
| --- | --- |
| profile | name, group_id (0 для преподавателя без группы) |
| group / subject | id (0 — создать), name, enabled (true — архивировать) |
| role | user_id, enabled (роль преподавателя) |
| assignment | teacher_id, subject_id, group_id, enabled |
| transfer | user_id, group_id; только без активных записей |
| lab | id (0 — создать), subject_id, group_id, number, name, enabled (true — архивировать) |
| grade | user_id, lab_id, value (2–5 или null), version (0 при отсутствии) |
| event_create | name, subject_id, group_ids[], starts_at (RFC3339), room, description, duration (минуты), strategy |
| event_update | event_id, name, starts_at, room, description, duration |
| event_action | event_id, action: open / close / start / complete / cancel |
| strategy | event_id, strategy: fifo / asc / desc / random |
| join | event_id |
| leave | event_id, id (ID записи, не пользователя) |
| next | event_id |
| skip / finish / remove | event_id, id (ID конкретной записи) |
| move | event_id, id, position (1-based среди ожидающих) |
| shuffle | event_id |

Ошибки: 400 — нарушено правило; 401 — недействительный вход; 403 — нет прав; 409 — дубликат/конфликт версии/ключа. Текст в поле `error`. Успех команды: `{"ok":true}`.

Все изменяющие действия логируются. Для оценки дополнительная запись `grade_change` содержит старое и новое значения. Отсутствие Telegram-уведомления не отменяет действие в приложении.

SSE передаёт сигналы после commit через PostgreSQL LISTEN/NOTIFY, в том числе между
экземплярами приложения с общей БД/схемой. Отклонённые команды и идемпотентные повторы
не создают сигнал. Сигналы не хранятся для повторной доставки: после переподключения
клиент получает свежий полный снимок с актуальными правами. Поток общий, но данные
остаются ограничены правами GET state. Изменения напрямую через SQL сигнал не создают.

Heartbeat — каждые 15 секунд; поток закрывается через 30 минут для переподключения.
Валидность Telegram-входа проверяется при открытии и heartbeat. Клиент использует
fetch-stream вместо EventSource, чтобы передавать initData в заголовке, а не URL.
Прокси должен пропускать streaming без буферизации; Caddyfile уже настроен.
