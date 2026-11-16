# Локальная приёмка — свидетельство прогона 2026-11-15

## Идентификация

- Base/application SHA: `7277f2012bedb798c12bcd382f563a04155ed39e`.
- Ветка: `codex/labturn-mvp`.
- Проверены исходники этого SHA плюс перечисленные ниже новые тесты. Код приложения и workflow не менялись. Это **не новый commit и не новый результат Actions**.
- Ранее выпущенный workflow: [43692536551 / attempt 2](https://github.com/Awak3r/it_proj/actions/runs/43692536551/attempts/2). Он не содержит этих новых тестов.
- Локальные исходные логи: `/tmp/labturn-full-acceptance-a_45mik5/`. Это временные файлы ПК, не production-данные и не CI artifact. Данный файл сохраняет компактные результаты; полные логи в Git не скопированы.

SHA-256 новых тестовых файлов на момент проверки:

```text
5c560d214db5cde5dedf85f3a88590b433a9882a612565b8ec5ec199b898ef5b  backend/acceptance_restart_test.go
ec2bb0ff2d727382636d1de64139e32cf314da76f0cb7d83de727388b4a13e01  backend/acceptance_test.go
c6935623790790816786d74ba0ed07fa4e1a0da5509a4f5af80961e8539a4b31  backend/notification_eta_test.go
9729810953f69a65984bd9443444450f854a24506e265f593ce9d4dffd27e19b  web/tests/acceptance.spec.ts
1a7d7f0bc53a5687f89dfab8b78e8c9365e0f0d98d47fa6eb5c7ee1a3bfb8c24  web/tests/notification-eta.spec.ts
```

## Среда и изоляция

```text
Linux / WSL2, local owner's PC
go version go1.26.5 linux/amd64
Node v22.23.5
postgres (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
Chromium: ~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome
```

Node 22 запускался из локального npm cache, а не из системного Node 18. Зависимости `web/node_modules` уже присутствовали; чистый `npm ci` в этом прогоне не выполнялся.

Временный PostgreSQL cluster создан через `initdb` в отдельном каталоге, bind `127.0.0.1:55441`; отдельные базы `labturn_test` (у каждого Go DB-теста собственная схема) и `labturn_dev` (синтетический demo seed). Приложение собрано в `/tmp`, bind `127.0.0.1:18080`, `BOT_TOKEN` пуст, `DEV_AUTH=true`, root `1001`. Health и config проверены до seed. Restart-тест запускает два ограниченных localhost child-процесса на временных портах с той же изолированной схемой. После проверок приложение, child-процессы и PostgreSQL остановлены. Production и Docker не использовались.

## Команды и результаты

Все результаты ниже — exit **0**.

| Каталог | Команда | Результат / локальный лог |
| --- | --- | --- |
| backend | `go test -race -count=1 -json ./...` с локальным TEST_DATABASE_URL | Финальный `go-test-final.jsonl`: package PASS, 17.832 s; 64 test pass events (24 top-level, включая родителей), **55 leaf cases**; 1 служебный skip, описан ниже |
| backend | `go vet ./...` | PASS; первоначальный полный прогон также сохранил `go-vet.log` |
| backend | `go build -o /tmp/labturn-full-acceptance-a_45mik5/labturn .` | PASS, `go-build.log` |
| backend | `go test -count=3 -shuffle=on -run '^TestAcceptanceShuffleSurvivesOSProcessRestart$' ./...` | PASS, 1.503 s; три цикла настоящего OS-process restart |
| web | `node node_modules/typescript/bin/tsc -b` (Node 22) | PASS, `typescript.log` |
| web | `node node_modules/vite/bin/vite.js build` (Node 22) | PASS, `vite-build.log` |
| корень | `BASE_URL=http://127.0.0.1:18080 python3 -B scripts/seed-demo.py` | PASS, `seed.log`; только свежая временная dev-БД |
| web | `node node_modules/@playwright/test/cli.js test --output=/tmp/labturn-full-acceptance-a_45mik5/playwright-results` (Node 22; BASE_URL localhost) | **42 passed (31.2s)**, `playwright.log` |
| корень | `bash -n scripts/build-image.sh scripts/compose-production.sh` | PASS |
| корень | `python3 -B -m unittest discover -s scripts -p 'test_*.py'` | **Ran 19 tests in 0.088s — OK**, `release-tests.log` |

Первоначальный объединённый Go/UI-прогон, до добавления OS-restart теста: `go-test.jsonl`, 63 pass events / 54 leaf cases, 0 skips. После добавления restart-теста повторно выполнен **полный** Go race suite и `go vet`, затем три дополнительных restart-повтора. UI-файлы между браузерным прогоном и финальным Go-прогоном не изменялись; их хеши указаны выше.

`TestAcceptanceRestartMainHelper` намеренно пропускается в родительском test runner: это entry point, который вызывает настоящий `main()` только в дочерних OS-процессах. Родительский `TestAcceptanceShuffleSurvivesOSProcessRestart` прошёл и подтвердил завершение первого PID, запуск замены, точное сохранение entries/порядка/shuffled/оценок и отказ повторного shuffle. Других пропусков в финальном Go-прогоне нет.

Сообщения вида `Deployed labturn-app:new` в Python release unit-тестах относятся к mock-командам. Ручного deploy на VPS не было.

## Браузерный итог по файлам

| Файл | PASS | Тип |
| --- | ---: | --- |
| `web/tests/acceptance.spec.ts` | 8 | Новый UI rendering/interaction с синтетическим API |
| `web/tests/notification-eta.spec.ts` | 15 | Новый UI ETA/позиция, синтетические снимки и фиксированные часы |
| `web/tests/app.spec.ts` | 5 | Настоящий локальный Go API и dev-БД |
| `web/tests/realtime.spec.ts` | 4 | Настоящий локальный API/SSE, в том числе сбои сети |
| `web/tests/recovery.spec.ts` | 3 | Настоящий локальный API/БД, внедрение сбоев и задержек |
| `web/tests/safe-area.spec.ts` | 7 | Браузерная геометрия / эмуляция Telegram inset |
| **Итого** | **42** | Нет пропусков |

## Что этим не подтверждено

- PostgreSQL 17 / Go 1.24.x: после согласованного commit/push нужен новый полный CI-прогон.
- Настоящий Telegram re-login AC-01, доставка реальных сообщений и полный телефонный WebView smoke test.
- Нагрузочная гарантия обновления до 5 секунд.
- Ручная приёмка владельцем и согласование уточнения формулы FR-16.

Подробная привязка каждого критерия и границы автоматизации: [ACCEPTANCE.md](../ACCEPTANCE.md).
