# LabTurn: локальная разработка на Windows ПК через WSL2

> Исторический документ: результаты и незавершённые шаги относятся к описанному этапу, не к текущему HEAD. Текущий [статус](../../STATUS.md).

Разработка, IDE, Go/Node, тесты и тестовые данные переносятся с VPS на ПК. **Production публикуется только через [GitHub Actions](../../DEPLOYMENT.md)** из ветки `codex/labturn-mvp`. Ручной release с ПК по SSH больше не используется; прежние команды `pc-release.sh deploy/release` отменены. Snapshot-архив больше не является основным источником проекта.

Инструкция для продолжающего работу агента: [LOCAL-AGENT-HANDOFF.md](LOCAL-AGENT-HANDOFF.md).

## 1. Подготовить WSL2 и локальный Docker

1. В Windows установите WSL2 с Ubuntu; при необходимости в PowerShell администратора: `wsl --install -d Ubuntu`. Завершите установку и перезагрузку. В `wsl --list --verbose` у Ubuntu должна быть версия **2**.
2. Установите Docker Desktop, включите **Use the WSL 2 based engine**, Linux containers и **Resources → WSL Integration → ваша Ubuntu**.
3. В WSL понадобятся Git, Bash, Python 3; для нативной разработки — Go 1.24.x и Node.js 22 с npm, либо версии, указанные в актуальных файлах проекта/CI. GitHub CLI (`gh`) нужен для настройки Actions и просмотра прогонов с разрешения владельца.
4. Перед любыми Docker-командами проверьте контекст:

   ```bash
   docker context show
   docker context ls
   docker context inspect
   ```

   **Endpoint должен вести в локальный Docker Desktop, НЕ на VPS.** Имя `default` само по себе ничего не гарантирует. Учитывайте переопределения `DOCKER_HOST`/`DOCKER_CONTEXT` и параметры CLI. Если endpoint удалённый или его происхождение непонятно, остановитесь и настройте локальное подключение; не запускайте build, Compose или тесты вслепую.

   Только после подтверждения локального endpoint:

   ```bash
   docker version
   docker buildx version
   docker compose version
   ```

Исходники храните в файловой системе WSL (`~/src/labturn`), а не в `/mnt/c`. Открывайте этот каталог локальной WSL-сессией Zed, не через remote-подключение к VPS.

## 2. Получить проект из нужной ветки GitHub

После того как родительский агент завершит commit/push:

```bash
mkdir -p ~/src
cd ~/src
git clone --branch codex/labturn-mvp --single-branch https://github.com/Awak3r/it_proj.git labturn
cd labturn
git branch --show-current
git --no-pager log -5 --oneline
git rev-parse HEAD
git ls-remote origin refs/heads/codex/labturn-mvp
```

Если каталог уже существует, не перезаписывайте его: сначала проверьте remote, ветку и рабочее дерево; обновляйте только fast-forward при отсутствии незавершённой работы. **Не создавайте новые ветки, не делайте force push и не merge в `main` без отдельного согласия.**

На момент передачи база — `95dc9e37c557ddf1744675aeb890243dd778d625` плюс safe-area патч и изменения процесса публикации. Родитель готовит два коммита и push; итоговый SHA нужно получить из фактического Git, а не из этой записи. Safe-area исправления включаются в коммиты: они не должны оставаться доступными только на VPS. Если ожидаемых файлов/коммитов в ветке нет, это блокер незавершённого push, а не повод возвращаться к архиву или сборке на VPS.

Прочитайте `AGENTS.md`, если он есть, README и документы из handoff до изменения кода.

## 3. Локальная конфигурация и отдельная БД

**Серверную `/home/ubuntu/labturn/source/.env` не переносить и не читать для настройки ПК.** Production-секреты остаются только на сервере. Для локальной `.env` создайте собственные значения; существующий файл не перезаписывайте. Минимальный пример исключительно для изолированной dev-среды:

```dotenv
POSTGRES_PASSWORD=local-only-change-me
ROOT_TELEGRAM_IDS=1001
DEV_AUTH=true
BOT_TOKEN=
APP_URL=
```

Примерный пароль не является production-секретом. Локальный `BOT_TOKEN` должен быть пустым: dev-тесты не должны отправлять настоящие сообщения. `DEV_AUTH=true` и `X-Dev-User` допустимы только локально с синтетическими пользователями, не на публичном сервере и не с production-данными.

Не переносите дампы production на ПК для обычной разработки. Не используйте production `DATABASE_URL`, `TEST_DATABASE_URL`, `BASE_URL` или SSH Docker context. Локальные volumes/БД независимы от серверных.

После проверки контекста и локальной конфигурации:

```bash
docker compose up --build -d
curl --fail http://127.0.0.1:8080/api/health
curl --fail http://127.0.0.1:8080/api/config
```

Адрес должен быть локальным, `dev_auth` — `true`, БД — вашей отдельной dev-БД. Только после этого и подтверждения, что база пуста, можно явно создать demo-данные:

```bash
BASE_URL=http://127.0.0.1:8080 python3 scripts/seed-demo.py
```

Seed изменяет данные. Не направляйте его на production, даже для диагностики. Для сохранения локальной работы также не применяйте `down -v` без осознанного согласия на удаление данных.

## 4. Локальные сборки и тесты

Новый интерфейс для сборки контейнера без публикации:

```bash
bash scripts/build-image.sh
# Необязательный явный версионный тег:
bash scripts/build-image.sh labturn-app:local-check
```

Скрипт только собирает обычный `Dockerfile` под **`linux/amd64`** через `docker buildx build --load` в локальном Docker Desktop. У него нет `deploy`/`release`; доставлять этот образ на VPS вручную нельзя. Dockerfile выполняет TypeScript/Vite и Go build, но **не заменяет полный Go/Playwright test suite**.

Для Go-интеграций нужна отдельная локальная PostgreSQL с тестовой БД. Compose по умолчанию не публикует порт PostgreSQL: не используйте произвольный localhost URL без подготовки базы. Например, если контейнер `labturn-local-tests` и порт `5433` ещё не заняты, создайте отдельный тестовый экземпляр на локальном Docker:

```bash
docker run -d --name labturn-local-tests \
  -e POSTGRES_USER=labqueue -e POSTGRES_PASSWORD=labqueue \
  -e POSTGRES_DB=labturn_test \
  -p 127.0.0.1:5433:5432 postgres:17-alpine
```

Дождитесь готовности PostgreSQL. Следующие учётные данные относятся только к этому синтетическому локальному экземпляру:

```bash
(cd backend && TEST_DATABASE_URL='postgres://labqueue:labqueue@127.0.0.1:5433/labturn_test?sslmode=disable' go test -race -count=1 ./... && go vet ./...)
python3 -B -m unittest discover -s scripts -p 'test_*.py'
(cd web && npm ci && npm run build && npx playwright install chromium)
(cd web && BASE_URL=http://127.0.0.1:8080 npm test)
```

UI-тестам нужен запущенный локальный dev-app с demo-данными; они изменяют оценки и очередь. Перед UI-прогоном после правок пересоберите/обновите локальное приложение, чтобы тестировать новый код. Набор release-тестов уточняйте по фактическому `checks.yml`. Нативный Go/Vite dev-запуск описан в [DEVELOPMENT.md](../../DEVELOPMENT.md).

Старые указания в DEVELOPMENT/QA про тесты «на сервере» относятся к прежнему процессу: **теперь все seed/UI/Go-тесты выполняются на ПК или GitHub-hosted runner, никогда на production VPS**.

## 5. Публикация и завершение переноса

После разрешённых владельцем commit/push в `codex/labturn-mvp` проверки, сборку и публикацию выполняет Actions: [DEPLOYMENT-GITHUB.md](../../DEPLOYMENT.md). Push не равен успешному deploy — нужно проверить результат deployment job и выпущенный SHA.

На VPS разрешены операционные SSH-чтения health/ps/logs. Не запускайте там build, seed, UI-тесты, IDE или language servers. Не удаляйте `/home/ubuntu/labturn/source`: серверу по-прежнему нужны Compose, Caddyfile и `.env`. После успешного переноса владелец вручную закрывает remote Zed; агент не должен убивать пользовательское SSH/редакторное соединение.

Первый реальный локальный запуск WSL2/Docker Desktop и первый Actions deploy ещё требуют подтверждения. Эта инструкция не утверждает, что они уже выполнены.
