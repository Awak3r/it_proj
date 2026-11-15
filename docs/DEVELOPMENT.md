# Локальная разработка и проверки

Go HTTP API + PostgreSQL 17 + React/TypeScript/Vite; Redis не требуется. Разработка, IDE, build, seed и UI-тесты — на ПК/WSL или GitHub-hosted runner, **никогда на production VPS**. Публикация — по [DEPLOYMENT.md](DEPLOYMENT.md); результаты и ручные проверки — в [STATUS.md](STATUS.md).

## Среда и исходники

- Windows: WSL2 Ubuntu (`wsl --install -d Ubuntu` из PowerShell администратора; `wsl --list --verbose` должен показывать версию 2).
- Docker Desktop: Linux containers, WSL2 engine и WSL Integration для Ubuntu. Нужны Git, Bash, Python 3, Go 1.24.x и Node.js 22; сверяйте версии с текущими файлами проекта/CI. `gh` нужен для Actions, не для локального запуска.
- Храните checkout в файловой системе WSL, не `/mnt/c`. Текущий sandbox владельца находится в `/home/bogdanoff/study/labturn`; его нативные процессы и данные описаны отдельно в [LOCAL-SANDBOX.md](LOCAL-SANDBOX.md).

Для нового checkout:

```sh
git clone --branch codex/labturn-mvp --single-branch https://github.com/Awak3r/it_proj.git labturn
cd labturn
git --no-optional-locks status --short
git branch --show-current
git --no-pager log -5 --oneline
git rev-parse HEAD
```

Существующий checkout не перезаписывать и не reset/clean; сначала сохранить работу, проверить remote без встроенного токена и ветку. Обновление — fast-forward при чистом дереве. Не создавать ветки, не force-push и не merge в `main` без согласия. Перед правками прочитать [AGENTS.md](../AGENTS.md), README, API и текущий статус. Архивный migration handoff не является обязательной инструкцией.

## Безопасный Docker и конфигурация

**До Docker-команд** проверить:

```sh
docker context show
docker context ls
docker context inspect
```

Endpoint должен вести в локальный Docker Desktop, не SSH/VPS; имя `default` этого не гарантирует. Учитывайте `DOCKER_HOST`, `DOCKER_CONTEXT` и CLI flags. При неясном endpoint остановитесь. После проверки: `docker version`, `docker buildx version`, `docker compose version`.

Создайте собственную локальную `.env`, не перезаписывая существующую:

```dotenv
POSTGRES_PASSWORD=local-only-change-me
ROOT_TELEGRAM_IDS=1001
DEV_AUTH=true
BOT_TOKEN=
APP_URL=
```

Это только локальные синтетические credentials. Не читать/копировать серверную `.env`, ключи и дампы; не использовать production URL/DSN. `DEV_AUTH`/`X-Dev-User` — только localhost. Пустой `BOT_TOKEN` исключает реальные сообщения.

```sh
docker compose up --build -d
curl --fail http://127.0.0.1:8080/api/health
curl --fail http://127.0.0.1:8080/api/config
```

Убедитесь, что app локален, `dev_auth=true`, БД отдельная и **пустая**, затем явно создайте demo:

```sh
BASE_URL=http://127.0.0.1:8080 python3 scripts/seed-demo.py
```

Seed изменяет данные. Demo: root `1001`, преподаватель `2001`, студенты `3001–3003`. Не применять seed/reset или data-changing UI suite к production и сохраняемому sandbox. Не удалять volumes (`down -v`) без отдельного согласия.

## Нативный запуск без контейнера app

Нужна подготовленная отдельная локальная PostgreSQL. Сохраняемый PostgreSQL 16 sandbox — исключение конкретного ПК, не замена CI PostgreSQL 17. Не запускайте второе приложение поверх занятого порта/БД.

```sh
(cd web && npm ci && npm run build)
# backend, с DSN отдельной локальной dev-БД:
cd backend
export DATABASE_URL='postgres://labqueue:local-only-change-me@127.0.0.1:5432/labqueue?sslmode=disable'
export ROOT_TELEGRAM_IDS=1001 DEV_AUTH=true BOT_TOKEN=
export LISTEN_ADDR=127.0.0.1:8080
go run .
```

DSN — пример для заранее созданной БД, не адрес автоматически запущенного сервиса. Compose не публикует порт PostgreSQL. Для hot reload в отдельном терминале `cd web && npm run dev` (проксирует `/api` на `:8080`).

## Сборка и тесты

Контейнерная сборка без публикации, только после проверки Docker endpoint:

```sh
bash scripts/build-image.sh labturn-app:local-check
```

Она собирает Dockerfile под `linux/amd64` через Buildx `--load`, без SSH/deploy. Это не полный test suite; вручную доставлять образ на VPS нельзя.

Go-интеграциям нужна **отдельная тестовая БД**, не dev/sandbox. Если имя и порт свободны, на проверенном локальном Docker:

```sh
docker run -d --name labturn-local-tests \
  -e POSTGRES_USER=labqueue -e POSTGRES_PASSWORD=labqueue \
  -e POSTGRES_DB=labturn_test \
  -p 127.0.0.1:5433:5432 postgres:17-alpine
```

Дождитесь готовности PostgreSQL. Из корня проекта:

```sh
(cd backend && TEST_DATABASE_URL='postgres://labqueue:labqueue@127.0.0.1:5433/labturn_test?sslmode=disable' go test -race -count=1 ./... && go vet ./... && go build -o /tmp/labturn-check .)
python3 -B -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/ci.py docs
bash -n scripts/build-image.sh scripts/compose-production.sh
(cd web && npm ci && npm run build && npx playwright install chromium)
(cd web && BASE_URL=http://127.0.0.1:8080 npm test)
```

UI suite изменяет очередь и оценки: используйте свежий отдельный локальный dev-app с demo-данными, пересобранный после правок. Для системного Chromium можно задать `CHROMIUM_PATH=/usr/bin/chromium`. Go DB-тесты создают/удаляют собственные схемы; недоступная DB и пропуск интеграций не равны успешной приёмке.

Фактический CI — [.github/workflows/checks.yml](../.github/workflows/checks.yml); параллельные тесты и единственная сборка образа описаны в [DEPLOYMENT.md](DEPLOYMENT.md). Фиксируйте команды, SHA, exit status и пропуски, не переносите исторический PASS на новый код.
