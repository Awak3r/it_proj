# Handoff: агенту LabTurn на ПК

> Исторический документ: результаты и незавершённые шаги относятся к описанному этапу, не к текущему HEAD. Текущий [статус](../../STATUS.md).

Следуйте этой инструкции после переноса разработки с VPS на Windows ПК. Это контекст и порядок работы, **не разрешение автоматически коммитить/пушить, создавать ключи или менять production**. Действия с доступами и публикацией выполняйте только в рамках согласия владельца.

## 1. Цель и неизменяемые границы

- Репозиторий: https://github.com/Awak3r/it_proj. Единственная согласованная рабочая/deploy-ветка: **`codex/labturn-mvp`**.
- Исходники, Zed, language servers, Go/Node, Docker build и тесты — на ПК в файловой системе WSL. Production-публикация — **только GitHub Actions**; VPS лишь принимает готовый образ и обслуживает приложение.
- Не делать merge в `main`, force push или новые ветки без спроса. Не возвращаться к ручному SSH release или snapshot как основному способу получения кода.
- Не читать/переносить production `.env`, ключи, токены и дампы для локальной разработки. Не выводить приватные ключи в терминал, чат, Git или логи.
- На VPS не запускать build, seed, UI-тесты, IDE и language servers. Допустимы операционные SSH-чтения health/ps/logs. Не удалять серверный каталог исходников, не выполнять `down -v`, не менять реальные оценки/очереди ради теста.
- Не обрывать пользовательское подключение к VPS. После завершения переноса попросить владельца вручную закрыть remote Zed.

## 2. Первый проход: сначала чтение и сверка состояния

1. Откройте WSL Ubuntu и локальный каталог `~/src/labturn` (не `/mnt/c` и не remote VPS workspace).
2. Получите репозиторий по инструкции [DEPLOYMENT-PC.md](DEPLOYMENT-PC.md), именно ветку `codex/labturn-mvp`. Если checkout уже есть, сначала сохраните пользовательскую работу и проверьте remote/ветку; не применяйте reset/clean.
3. Прочитайте применимые `AGENTS.md`, если они есть в checkout или родительских каталогах, затем:
   - [README](../../../README.md);
   - [локальную разработку](DEPLOYMENT-PC.md) и [DEVELOPMENT.md](../../DEVELOPMENT.md);
   - [API.md](../../API.md), особенно авторизацию, идемпотентность и SSE;
   - [QA-отчёт](../qa/REPORT.md), [известные дефекты](../qa/BUGS.md), [SSE](../qa/SSE.md);
   - [DEPLOYMENT-GITHUB.md](../../DEPLOYMENT.md);
   - фактические `.github/workflows/deploy.yml`, `checks.yml` и сборочные/release-тесты.
4. До Docker-команд проверьте `docker context show/ls/inspect` и переменные переопределения endpoint. Docker должен быть **локальным Docker Desktop**, не VPS. При сомнении остановитесь.
5. Установите фактическую ревизию без вывода секретов:

   ```bash
   git --no-optional-locks status --short
   git remote -v
   git branch --show-current
   git --no-pager log -5 --oneline
   git rev-parse HEAD
   git ls-remote origin refs/heads/codex/labturn-mvp
   ```

   Remote должен быть указанным GitHub-репозиторием без встроенного токена в URL; такой токен нельзя публиковать. Не считайте локальный HEAD равным remote SHA до сверки.

Историческая база на момент подготовки — `95dc9e37c557ddf1744675aeb890243dd778d625` плюс safe-area патч и подготовка нового pipeline. Родитель сделает **два коммита и push**; итоговые SHA здесь намеренно не зафиксированы. Все safe-area изменения должны попасть в эти коммиты, а не оставаться навсегда локальными. Если ветка ещё на старой базе или нет новых интерфейсов, сообщите о незавершённом push и дождитесь его.

## 3. Что известно о работающем приложении

| Параметр | Значение |
| --- | --- |
| VPS | `ubuntu@92.5.236.71` |
| Production URL | https://labturn.awak3r.ru |
| Telegram-бот | `@labturn_bot` |
| Production root Telegram ID | `1297278646` |
| Серверный root / исходники | `/home/ubuntu/labturn` / `/home/ubuntu/labturn/source` |
| Ops | `/home/ubuntu/labturn/ops` |
| Production secrets | `/home/ubuntu/labturn/source/.env`, права `600`, только сервер |
| Backup | `/var/backups/labturn`, root-owned, каталог `700`, ежедневно, хранение 7 дней |

Стек: Go HTTP API + PostgreSQL 17 + React/TypeScript/Vite. Go раздаёт готовую статику, Caddy обеспечивает HTTPS/SSE. Production использует Telegram initData; `DEV_AUTH` на публичном сервере должен быть выключен. Данные очереди, оценок, прав и истории находятся в PostgreSQL, не в памяти процесса.

### Подтверждено до этой передачи, не новым прогоном агента на ПК

- Владелец проверил реальный Telegram WebView: owner login, root-доступ и SSE. Зафиксированы первое событие **77 мс**, heartbeat на **15/30/45 секундах**, reconnect **240 мс**. Это наблюдения конкретной сессии, не SLA.
- Последующий CSS safe-area патч прошёл **7 браузерных geometry tests** и был развёрнут в образе с известным префиксом ID **`907bdaaf...`**. Это не полный image ID и не SHA нового GitHub-релиза.
- Backup и восстановление в отдельную БД были проверены; ежедневный backup настроен. **Offsite backup отсутствует.**
- Исторические Go/QA/SSE результаты доступны в документах и evidence. Их нельзя выдавать за проверки нового commit или нового Actions deployment.

### Ещё не подтверждено

- Реальный телефон **после** CSS safe-area патча. Предыдущая owner WebView/SSE проверка не закрывает этот пункт.
- Первый реальный запуск конкретной WSL/Docker Desktop среды пользователя.
- Push новых коммитов и первый успешный deploy через новый GitHub Actions pipeline. Не заявляйте, что новый commit уже опубликован или выпущен.

В старых QA/SSE-документах есть исторические формулировки «WebView не проверен», а в DEVELOPMENT — «UI на сервере». Более свежий статус приведён выше; запускать тесты теперь разрешено только локально/на runner. Не меняйте исторические результаты на выдуманные новые.

## 4. Безопасная локальная работа и проверки

Настройте WSL2/Docker Desktop и локальные Go 1.24.x/Node.js 22 по [DEPLOYMENT-PC.md](DEPLOYMENT-PC.md), сверив версии с текущими файлами. Создайте **собственную** локальную dev-конфигурацию: `BOT_TOKEN` пуст, `DEV_AUTH=true`, dev-root `1001`. Не используйте production root как dev-учётную запись, production БД или серверные credentials.

Перед запуском проверяйте адреса `BASE_URL`, `DATABASE_URL`, `TEST_DATABASE_URL`. Dev-app и seed должны использовать только `http://127.0.0.1:8080` и отдельную локальную dev-БД. Go-интеграциям выделите отдельную тестовую PostgreSQL; порт сервиса БД в обычном Compose наружу не опубликован. UI-тесты изменяют данные, поэтому нужны синтетические demo-данные, а не production snapshot.

План валидации:

1. Локально собрать frontend и Go; контейнер можно проверить `bash scripts/build-image.sh [labturn-app:version]` — **это только build**, всегда `linux/amd64`, Buildx `--load`.
2. Выполнить Go tests с race detector и PostgreSQL, `go vet`, Python release/unit tests согласно актуальному `checks.yml`.
3. Запустить Playwright против свежего локального dev-app с demo-данными; проверить SSE/recovery и safe-area geometry.
4. Указать точные команды, exit status и пропущенные проверки. Успешный Dockerfile build — не полный test suite.

Нельзя запускать удалённые Docker-команды через незаметно оставшийся VPS context. Нельзя обходить падающий тест seed/reset на production. Не коммитьте `.env`, testdata с реальными данными, ключи, дампы и build-артефакты.

## 5. CI-доступы и публикация

Полные действия: [DEPLOYMENT-GITHUB.md](../../DEPLOYMENT.md). Краткий контракт:

- `deploy.yml`: push только `codex/labturn-mvp`, reusable `checks.yml` (Go/PostgreSQL/UI/release), build на GitHub-hosted Ubuntu, artifact `image.tar.gz`, отдельный deployment job с environment `production`.
- Единственный настраиваемый secret — environment `production` → `VPS_SSH_KEY`. Нужна пользовательская `gh auth` с необходимыми правами; доступы не предполагаются существующими.
- С согласия владельца создать **отдельный** `~/.ssh/labturn_actions`, Ed25519 без passphrase, private `600`. Существующий ключ не перезаписывать. Public передать через `/usr/local/sbin/labturn-authorize-ci-key`, private — прямо из файла в `gh secret set`, никогда не печатать.
- Если нужно, создать environment через `gh api --method PUT repos/Awak3r/it_proj/environments/production`; в UI ограничить доверенной веткой `codex/labturn-mvp` до публикации.
- `.github/vps_known_hosts` содержит pin ED25519 VPS. Не отключать host verification.
- Root-owned `/usr/local/sbin/labturn-ci-ssh` разрешает CI-ключу только `labturn-check` и `labturn-deploy labturn-app:gh-<40hex SHA>-<run_id>-<attempt>`. Регистрация public key добавляет `restrict,command="/usr/local/sbin/labturn-ci-ssh"`, не трогая другие строки `authorized_keys`.
- На VPS уже установлен receiver с проверкой gzip manifest/архитектуры/конфига, backup, app-only up и rollback образа. **БД при rollback не откатывается.** Не обещать zero downtime: app перезапускается, SSE переподключается.

Не смешивайте три доступа: личный SSH владельца для обслуживания VPS; CI-ключ Actions → VPS; **временный read-write GitHub deploy key VPS → GitHub для родительского push**. У VPS пока нет готовых push credentials: owner получил временный public deploy key с просьбой добавить его. После успешного push родитель удалит temporary private key с VPS. Этот ключ нельзя переносить на ПК или класть в `VPS_SSH_KEY`.

`workflow_dispatch` в UI требует workflow в default branch; до merge в `main` основной триггер — push `codex/labturn-mvp`. **Не merge main ради кнопки.** При разрешённом push проверьте SHA и результат каждого job: checks/build без успешного deployment job ещё не означают выпуск.

## 6. Дальнейшие задачи в порядке приоритета

1. Подтвердить успешный родительский push, фактические remote SHA и наличие всех safe-area/pipeline изменений.
2. Поднять и проверить локальную dev/test-среду с отдельными БД; перенести туда дальнейшую работу. После этого попросить владельца закрыть remote Zed вручную.
3. С разрешения владельца проверить `gh auth`, создать/ограничить production environment, зарегистрировать отдельный CI public key и загрузить environment secret.
4. Согласовать первый push-триггер, убедиться, что проверки, build/artifact и deployment прошли на ожидаемом SHA. После уже состоявшегося раннего push не создавать пустой commit/новую ветку автоматически ради перезапуска.
5. Операционно прочитать health/ps/logs без раскрытия секретов; запросить у владельца проверку телефона после safe-area патча. Не изменять реальные оценки или очередь ради smoke test.
6. Отдельно согласовать offsite backups и требования к совместимости будущих миграций. Не восстанавливать БД автоматически при ошибке релиза.

В первом ответе владельцу кратко перечислите фактический SHA/ветку, выполненные локальные проверки, оставшиеся блокеры и действия, требующие согласия. Не выдавайте исторические результаты за новый прогон.
