# Приёмка MVP: AC-01–AC-28, FR-15 и FR-16

Дата проверки: **15 ноября 2026**. Источник требований: [README, разделы 9 и 13](../../README.md).

## Ревизия и границы результата

- Выпущенный через Actions SHA: **`7277f2012bedb798c12bcd382f563a04155ed39e`**. [Run 43692536551, attempt 2](https://github.com/Awak3r/it_proj/actions/runs/43692536551/attempts/2): checks/build/deploy успешны; исходный набор Playwright — 19 тестов.
- Матрица ниже получена **локально на исходниках этого SHA с добавленными тестами**. Код приложения не изменён. Новые тесты ещё не закоммичены и не выполнялись в выпущенном workflow; не приписывать его зелёному статусу расширенное покрытие.
- Среда полного локального прогона: WSL2, Go **1.26.5**, Node **22.23.5**, PostgreSQL **16.15**, Chromium Playwright. CI использует Go 1.24.x / Node 22 / PostgreSQL 17; повтор расширенного набора на этих версиях ещё нужен после согласованного commit/push.
- Приложение слушало только `127.0.0.1:18080`, временная PostgreSQL — `127.0.0.1:55441`; отдельные `labturn_dev` и `labturn_test`, синтетические пользователи, пустой `BOT_TOKEN`, `DEV_AUTH=true`. После прогона процессы остановлены. Docker, production-БД и реальные сообщения не использовались.
- [Компактное свидетельство прогона и хеши новых тестов](evidence/acceptance-local-2026-11-15.md). Исходные локальные логи — временные, не являются долговечным CI artifact.

## Итог автоматического прогона

- Go: **85 конечных сценариев PASS** (включая взвешенное оценивание, миграции, точность весов; 24 верхнеуровневых теста). Единственный SKIP — служебный `TestAcceptanceRestartMainHelper` в родительском процессе: он выполняется в дочерних процессах restart-теста. Пропусков проверок требований нет.
- `go vet`, Go build, TypeScript build и Vite build: exit 0.
- Playwright: **60/60 PASS** (19 существующих + 8 наboarding/acceptance + 15 FR-16/позиция + 18 новых взвешенного оценивания, включая 1 реальный API/UI интеграционный тест).
- Python release tooling: **19/19 PASS**; shell syntax check: exit 0.
- Restart-тест дополнительно прошёл три повтора с `-shuffle=on`.
- Полный Actions workflow на SHA `aff2173dd968325afb075ffe60ff3e9337020436`: checks/build/deploy **success**; production-образ `labturn-app:gh-aff2173dd968325afb075ffe60ff3e9337020436-43705072514-1` healthy.

## Как читать матрицу

**Авто PASS** — указанные утверждения проверены автоматически в полном локальном прогоне. Это не подтверждение всех сочетаний состояний и не ручная приёмка.

**Частично** — автоматическая часть прошла, но буквальный критерий требует дополнительного сценария.

Обозначения и файлы:

- **A/Имя** = `TestAcceptanceИмя` в [backend/acceptance_test.go](../../backend/acceptance_test.go).
- **I/имя** = `TestIntegration/имя` в [backend/integration_test.go](../../backend/integration_test.go); в Go-выводе пробелы заменяются `_`.
- **N/Имя** = `TestFR15Имя` в [backend/notification_eta_test.go](../../backend/notification_eta_test.go).
- **UI-A** = [web/tests/acceptance.spec.ts](../../web/tests/acceptance.spec.ts), **UI-E** = [web/tests/notification-eta.spec.ts](../../web/tests/notification-eta.spec.ts). Эти новые браузерные тесты перехватывают API и проверяют настоящий интерфейс на синтетических снимках/командах, **не backend persistence или реальный SSE**.
- **UI-App** = [web/tests/app.spec.ts](../../web/tests/app.spec.ts), **UI-Recovery** = [web/tests/recovery.spec.ts](../../web/tests/recovery.spec.ts), **UI-Realtime** = [web/tests/realtime.spec.ts](../../web/tests/realtime.spec.ts): работают с настоящим локальным API/БД; отдельные сетевые сбои внедряются перехватом запросов.

## Матрица критериев

| ID | Что проверено | Тест / точка покрытия | Результат и граница |
| --- | --- | --- | --- |
| AC-01 | Повторное обращение с тем же ID возвращает тот же профиль, группу и время создания; отдельный server/pool не создаёт пользователя заново | A/ProfileReentry; `TestTelegramAuth` в `backend/auth_test.go` отдельно проверяет подпись/идентичность | **Частично**: persistence PASS; настоящий повторный вход через Telegram на текущем релизе не выполнен |
| AC-02 | Root создаёт группу, предмет, роль и назначение; назначенный преподаватель создаёт событие | Setup `TestIntegration`: команды `group`, `subject`, `role`, `assignment`, затем `makeEvent`; I/authorization; UI-App `root has management and a single manual shuffle` проверяет доступность управления | **Авто PASS** через API; полный root CRUD-клик-путь не заявляется |
| AC-03 | Запись без выбора лабораторной, одна активная запись | A/MembershipReentryAndIndependentCalls; I/concurrent duplicate join | **Авто PASS** |
| AC-04 | 20 конкурентных запросов одного студента оставляют одну активную запись | I/concurrent duplicate join | **Авто PASS** |
| AC-05 | Один студент одновременно состоит в двух событиях | A/MembershipReentryAndIndependentCalls | **Авто PASS** |
| AC-06 | Выход сохраняет историю; повторный вход создаёт новый ID и более позднее время | A/MembershipReentryAndIndependentCalls | **Авто PASS** |
| AC-07 | FIFO соответствует времени/ID, включая равные timestamps; фактическая последовательность вызовов | A/FIFOAndTiedJoinOrder; `TestQueueInsertion/ties stable` в `backend/queue_test.go` | **Авто PASS** |
| AC-08 | Реальные оценки дают 1/3/5 сданных работ; asc/desc, стабильные равенства; 2/null/архив/другие предметы и группы исключены | A/ScoreOrderOneThreeFive; `TestQueueInsertion` | **Авто PASS**; изменения оценок после записи не меняют зафиксированный score |
| AC-09 | Root получает одну перестановку всех участников без потерь/дубликатов; replay безопасен; второй shuffle отклонён | A/ShufflePermutationSurvivesNewServer; I/random root only once and durable; UI-App `root has management and a single manual shuffle` | **Авто PASS**; не требуется, чтобы случайный порядок обязательно отличался от исходного |
| AC-10 | После shuffle настоящий процесс приложения завершён через SIGTERM и запущен заново с той же БД; точные entries/order, shuffled-флаг и оценки сохранены для всех ролей; второй shuffle запрещён | `TestAcceptanceShuffleSurvivesOSProcessRestart` в [backend/acceptance_restart_test.go](../../backend/acceptance_restart_test.go); A/ShufflePermutationSurvivesNewServer | **Авто PASS**: два разных OS-процесса вызывают настоящий `main()` и обслуживают реальные HTTP-запросы; БД/данные локальные |
| AC-11 | Новичок после shuffle добавляется в конец, прежний порядок сохраняется | A/ShufflePermutationSurvivesNewServer; I/random root only once and durable | **Авто PASS** |
| AC-12 | Конкурирующие/повторные вызовы не создают двух called в одном событии; устаревший finish безопасен | I/single current call and stale finish; N/CallNotificationContentAndRecall | **Авто PASS** |
| AC-13 | Пропущенный студент уходит в конец, called_at очищен, оценки/score не меняются; для неоценённого не создаётся строка оценки | A/SkipPreservesGradesAndProgress; I/skip and newcomers | **Авто PASS** |
| AC-14 | Оценки 4 и 5 сохранены по двум работам, обе засчитаны, студент остаётся called | A/MultipleGradesFinishOnlyCurrentEntry; UI-App `teacher grade autosave keeps student in queue and finish is separate`; UI-A `grade 4/5 counts as passed after save` | **Авто PASS**; арифметика UI проверена с подменой API |
| AC-15 | 2 не засчитывается; finish успешен; новая запись разрешена | A/FailingGradeAllowsFinishAndReentry; UI-A `grade 2 counts as remaining after save` | **Авто PASS** |
| AC-16 | Повтор сохранения не создаёт вторую версию/оценку; повторный/устаревший finish не завершает следующего или новую запись того же студента | A/MultipleGradesFinishOnlyCurrentEntry; I/concurrent grade conflict and durable replay; UI-Recovery `lost response retries the same grade without a second write` | **Авто PASS** |
| AC-17 | Отклонённая/конфликтная запись возвращает ошибку и сохраняет визит; pending/error блокируют finish; явная отмена возвращает сохранённую оценку и разрешает finish | A/RejectedGradePreservesVisit; UI-Recovery (3 сценария); UI-A `pending and rejected grade block finish; explicit cancel restores committed value and permits finish` | **Авто PASS**; явная отмена дополнительно проверена на подменённом ответе 409 |
| AC-18 | Закрытие регистрации запрещает новый join, но не next/finish для уже записанных | A/RegistrationCloseAndTerminalHistory; I/close vs complete and notification outbox | **Авто PASS** |
| AC-19 | complete закрывает активные записи с ended_at, сохраняет историю, не переносит их и не меняет другое событие; терминальные действия запрещены | A/RegistrationCloseAndTerminalHistory/complete; N/TerminalNotificationKinds | **Авто PASS**; отдельно проверена отмена |
| AC-20 | В снимке студента есть его и чужая оценка своей группы; чужая группа исключена | A/StudentGradebookAndDeniedMutations; I/student grade scope; UI-App `student desktop navigation and grade permissions` | **Авто PASS** |
| AC-21 | Сервер запрещает студенту move и grade; нет изменений очереди, оценки и аудита; UI не даёт редактирования | A/StudentGradebookAndDeniedMutations; I/authorization; UI-App `student desktop navigation and grade permissions` | **Авто PASS** |
| AC-22 | Перемещённый root порядок одинаков в снимках участников и нового server; изменение оценки не отменяет порядок; новичок добавляется по согласованному правилу | A/ManualOrderVisibleAndPersistent; I/manual priority and idempotency; UI-Realtime отдельно проверяет получение изменений без навигации | **Авто PASS**; одновременное визуальное отображение именно move во всех браузерах отдельно не моделировалось |
| AC-23 | Ошибка транспорта откладывает уведомление, не блокирует finish/next; состояние доступно студенту; повтор после нового server доставляет запись | N/DeliveryFailureDoesNotBlockQueue; I/notification recovery | **Авто PASS** с HTTP transport-заглушкой; настоящая доставка Telegram не подтверждается |
| AC-24 | Один студент called в двух событиях; завершение одного не закрывает другой вызов | A/MembershipReentryAndIndependentCalls | **Авто PASS** |
| AC-25 | Преподаватель меняет ранее внесённую root оценку студента вне очереди; проверены author/version/audit и неизменность очередей | A/OtherAuthorOutsideQueueAndClear | **Авто PASS** |
| AC-26 | Очистка 4 даёт null и уменьшает число сданных; очереди двух событий не закрываются | A/OtherAuthorOutsideQueueAndClear; UI-A `grade null counts as remaining after save` | **Авто PASS** |
| AC-27 | После нескольких оценок finish закрывает только текущую запись; оценки, следующий студент и другое событие сохранены | A/MultipleGradesFinishOnlyCurrentEntry; UI-App `teacher grade autosave keeps student in queue and finish is separate` | **Авто PASS** |
| AC-28 | Во время live-приёма rename/add/archive меняют снимок работ и входные данные прогресса, не теряют историю/оценки/очередь; UI пересчитывает сдано/осталось | A/LabChangesDuringLiveVisit; UI-A `adding and archiving labs immediately updates passed and remaining arithmetic`, `remote lab snapshots update progress on live reconnect without navigation` | **Авто PASS**; новые UI-сценарии используют синтетические команды/SSE |

## FR-15: уведомления и позиция

Реализация: `backend/queue.go`, `backend/notifications.go`; клиент очереди — `web/src/main.tsx`.

| Правило | Проверка | Итог |
| --- | --- | --- |
| Приближение: впереди не более двух, не чаще одного outbox-события за запись | N/NearNotificationEligibility; N/NearThresholdAndOncePerEntry | PASS: live; random только после shuffle; called считается впереди; завершённые/вышедшие не считаются; повтор обхода/возврат в порог не дублирует near; новая запись может получить новое near |
| Вызов: предмет, событие, аудитория при наличии | N/CallNotificationContentAndRecall | PASS для комнаты и без неё; повтор next не создаёт новое уведомление текущему; повторный вызов после skip имеет новый kind |
| Завершение и отмена события | N/TerminalNotificationKinds/complete и /cancel | PASS: разные сообщения, общий kind `closed`; адресаты — только активные записи |
| Только закрытие регистрации | N/TerminalNotificationKinds | PASS: терминальное уведомление не создаётся, приём существующих участников продолжается (AC-18) |
| Ошибка доставки не останавливает очередь | N/DeliveryFailureDoesNotBlockQueue; I/notification recovery | PASS: attempts/next_at, последующий повтор, актуальный snapshot |
| Позиция и состояние в Mini App | UI-E: активные участники, called, random до/после shuffle; UI-Realtime | PASS в браузере; настоящий WebView на текущем релизе — ручная проверка |

**Не обещается exactly-once доставка в Telegram.** Ограничение near относится к записи в outbox. После аварии между отправкой и фиксацией результата доставка может повториться (at-least-once). Все новые проверки доставки используют заглушки и не отправляют настоящих сообщений.

## FR-16: оценка ожидания

Реализация: `backend/main.go` возвращает `average_minutes`; `web/src/main.tsx` вычисляет `remainingWait`.

- `TestFR16AverageUsesOnlyCompletedVisitsInCurrentEvent`: среднее только завершённых приёмов текущего события с called_at; остальные состояния/события исключены, без выборки — null. **PASS**.
- UI-E, **15 сценариев**: длительность по умолчанию до накопления данных; приоритет среднего; округление вверх; «недостаточно данных»; прибавка до планового старта; прошедший старт не уменьшает ожидание; live не добавляет плановую задержку; позиции без дыр/истории; ноль людей впереди; random скрывает позицию и ETA до shuffle; called показывает вызов вместо ETA. **PASS**.
- Оценка отображается с `≈`, то есть не как обещанное время приёма.
- **Уточнение к предложенной формуле ТЗ:** UI вычитает уже прошедшую часть текущего приёма, ограничивая вычитание одной средней длительностью. Это поведение проверено, но его следует явно подтвердить владельцу либо отдельно согласовать изменение. Код формулы в рамках аудита не менялся.

## FR-17: веса и обязательность работ (взвешенный средний, итоговая подсказка)

Реализация: `backend/grading.go`, `backend/weights.go`, `backend/migrations.go`, `backend/migrations/0001_weighted_grading.sql`; клиент — `web/src/main.tsx`, `web/src/GradeSummaryCells.tsx`, `web/src/types.ts`.

| Правило | Проверка | Итог |
| --- | --- | --- |
| Каждая работа имеет положительный вес (не больше 1 000 000) | `TestWeightedLabMetadata`; `TestWeightedGradingArithmetic`; UI `lab form defaults, decimal-string payload, positive validation` | **Авто PASS**: вес `1` по умолчанию; `0`, отрицательный, `>1e6`, нечисло отклоняются HTTP 400; точность десятичной строки сохраняется (`weight_text`) |
| Обязательная работа без оценки считается за 2 и блокирует итог | `TestWeightedGradingArithmetic`; UI `uses server required counts instead of inferring completion` | **Авто PASS**: пустая обязательная → 2 в среднем, `final_hint=null` |
| Обязательная с оценкой 2 блокирует итог | `TestWeightedGradingArithmetic` | **Авто PASS** |
| Обязательная с оценкой 3–5 считается сданной | `TestWeightedGradingArithmetic` | **Авто PASS** |
| Необязательная без оценки исключается из среднего и знаменателя | `TestWeightedGradingArithmetic`; UI `allows an ungraded optional lab when required work is passed` | **Авто PASS**: вес необязательной без оценки не учитывается |
| Необязательная с оценкой 2–5 участвует в среднем, не блокирует итог | `TestWeightedGradingArithmetic` | **Авто PASS** |
| Архивные работы исключены | `TestWeightedGradingArithmetic` | **Авто PASS** |
| Средний — взвешенный, `average` с 2 знаками, `final_hint` из точного среднего (половина вверх) | `TestWeightedGradingArithmetic`; UI `does not double-round the server final hint` | **Авто PASS**: `0.500000000000000000001` + `0.499999999999999999999` с оценками 4/5 → средний 4.50, итог 4 |
| Итоговая подсказка только после сдачи всех обязательных работ | `TestWeightedGradingArithmetic`; UI `uses server required counts` | **Авто PASS**: `required_total=required_passed` и знаменатель > 0 |
| Подсказка — не выставленная оценка, не записывается в grades | Код: итог не сохраняется в БД; UI подпись «Подсказка, не выставленная оценка» | **Авто PASS** |
| Права доступа как у ведомости (root/учитель/студент) | `TestWeightedSummaryScopeAndRevocation`; `TestWeightedDualRoleMembership`; UI `student sees summaries and metadata read-only` | **Авто PASS**: студент видит свою группу, учитель — назначенные пары, root — всё |
| Редактирование веса/обязательности обновляет снимок | `TestWeightedLabMetadata`; UI `editing weight and required updates metadata and fresh authoritative summary` | **Авто PASS** |
| Старые работы без метаданных: вес=1, обязательная=true | `TestMigrationsUpgradeAndCompatibility`; UI `lab form defaults` | **Авто PASS**: аддитивная миграция, обратная совместимость |

**Не обещается:** конструктор произвольных формул, типы работ (ЛР/КР/коллоквиум), Excel-экспорт, диаграммы — следующие этапы.

## Ручная приёмка — не закрыта автоматически

| Проверка | Статус | Безопасный порядок |
| --- | --- | --- |
| AC-01: повторный настоящий Telegram-вход возвращает профиль | Не выполнена на текущем SHA в этом аудите | Владелец закрывает/открывает Mini App со своим аккаунтом, сверяет профиль; не передаёт initData в чат |
| AC-10: сохранение shuffle после остановки/старта процесса | **Закрыта автоматически локально**, ручной restart production не нужен | `TestAcceptanceShuffleSurvivesOSProcessRestart` выполняет реальный restart на изолированном стенде; ожидается повтор в CI на PostgreSQL 17 |
| FR-15: реальные сообщения near/call/complete/cancel | Не выполнена | Отдельный тестовый бот и добровольные тестовые аккаунты; токен вне Git/логов. Не менять настоящие очереди и оценки ради теста |
| Телефон после safe-area патча: клавиатура, поворот, возврат/сеть | Не выполнена полностью | Настоящий Telegram WebView владельца; браузерная эмуляция не заменяет телефон |

Старый handoff содержит историческое подтверждение owner login/SSE до этой приёмки; оно не записывается как новый результат. Сообщение владельца о пустом списке групп показало необходимость первоначальной настройки групп root; это не считается успешным прохождением студенческого onboarding.

## Что требует согласования / следующего прогона

1. Подтвердить уточнение FR-16 с вычитанием уже прошедшего времени текущего приёма. Остальные правила с пометкой «допущение» применяются в границах решений README v0.3, а не становятся новыми согласованными требованиями только из-за теста.
2. commit/push новых тестов выполнен (SHA `aff2173dd968325afb075ffe60ff3e9337020436`); весь workflow пройден на PostgreSQL 17 / Go 1.24.x в Actions; production-развёртывание healthy.
3. Закрыть реальные Telegram/WebView-проверки. До этого итоговая ручная приёмка MVP **не завершена**. Буквальный restart AC-10 уже закрыт локальным автоматическим тестом.
4. Цель 100 пользователей / 10 событий / обновление до 5 секунд — отдельное согласование и измерение задержек. Текущий I/100 users and 10 events проверяет корректность, не SLA интерфейса.

## Повторение автоматических проверок

Сначала подготовить **отдельные локальные** dev/test PostgreSQL по [DEPLOYMENT-PC.md](../DEPLOYMENT-PC.md); не использовать production URL/DSN. Новые Go fixtures создают отдельную схему на тест и отклоняют нелокальный host/fallback.

```sh
# backend; указать DSN вашей отдельной локальной тестовой БД
TEST_DATABASE_URL='postgres://labqueue@127.0.0.1:55441/labturn_test?sslmode=disable' go test -race -count=1 ./...
go vet ./...
go build -o /tmp/labturn-acceptance .

# web, Node 22; зависимости должны быть установлены через npm ci
npm run build

# Запустить собранное приложение с отдельной пустой dev-БД:
# BOT_TOKEN=, DEV_AUTH=true, ROOT_TELEGRAM_IDS=1001,
# LISTEN_ADDR=127.0.0.1:18080, WEB_DIST=<полный путь к web/dist>.
# DATABASE_URL должен указывать на локальную labturn_dev, не labturn_test.
# После проверки /api/config == {"dev_auth":true}:
BASE_URL=http://127.0.0.1:18080 python3 scripts/seed-demo.py

# web; полный набор, в том числе существующие real-API тесты
BASE_URL=http://127.0.0.1:18080 npm test

# корень проекта
bash -n scripts/build-image.sh scripts/compose-production.sh
python3 -B -m unittest discover -s scripts -p 'test_*.py'
```

Команды сгруппированы по рабочим каталогам; значения DSN/портов выше относятся только к завершённому временному локальному прогону, не к постоянно работающим сервисам. При недоступной TEST_DATABASE_URL пропуск DB-тестов **не считается** успешной приёмкой. CI уже собирает все `*_test.go` и `tests/*.spec.ts`; отдельное добавление новых файлов в workflow не требуется.
