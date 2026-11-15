# LabTurn: production-публикация только через GitHub Actions

Разработка идёт на ПК в WSL: [DEPLOYMENT-PC.md](DEPLOYMENT-PC.md). Репозиторий — https://github.com/Awak3r/it_proj, рабочая и публикуемая ветка — **`codex/labturn-mvp`**. Переход на Actions не требует merge в `main`. Ручной release с ПК/VPS и прежний `pc-release.sh deploy/release` больше не используются.

## 1. Pipeline и границы доверия

Новый `.github/workflows/deploy.yml` имеет следующий контракт:

1. Запускается на **push только в `codex/labturn-mvp`**; также объявлен `workflow_dispatch`.
2. Вызывает reusable `.github/workflows/checks.yml`: Go с PostgreSQL, UI и release-тесты. Seed и тесты работают на изолированном GitHub-hosted runner, не на VPS.
3. После успешных проверок собирает обычный Dockerfile на GitHub-hosted Ubuntu под **`linux/amd64`**, с Buildx `--load`.
4. Сохраняет gzip `docker save` как artifact **`image.tar.gz`** текущего прогона.
5. Отдельный deployment job использует GitHub environment **`production`**, скачивает artifact этого прогона, выполняет SSH preflight и передаёт gzip receiver на VPS.

Имя публикуемого образа строго привязано к прогону:

```text
labturn-app:gh-<40hex SHA>-<run_id>-<attempt>
```

Не заменяйте SHA короткой ревизией или тегом `latest`. Повторная попытка получает свой `attempt`. Artifact, SHA, run ID и deployment должны относиться к одному прогону. GHCR и отдельный registry не используются.

**Важно:** кнопка ручного `workflow_dispatch` доступна в UI, когда workflow присутствует в default branch. Пока workflow находится только в `codex/labturn-mvp`, основной способ запуска — push в эту ветку. Не делайте merge в `main` ради кнопки и не обещайте её наличие до такого изменения.

На момент подготовки документа новый процесс ещё не опубликован/не выпущен. Родитель должен завершить два коммита и push; после этого проверяются фактические remote SHA, workflow и его результат. Само наличие инструкции не означает успешный прогон Actions.

## 2. Однократная настройка GitHub владельцем или уполномоченным локальным агентом

Для `gh` нужна **пользовательская авторизация** с правами на этот репозиторий, environments и secrets. Не предполагается, что она уже есть:

```bash
gh auth status
```

Если доступа нет, попросите владельца авторизовать GitHub CLI стандартным способом или выполнить административные шаги самостоятельно. Не выдумывайте токены и не просите присылать их в чат.

Если environment `production` отсутствует, создайте его:

```bash
gh api --method PUT repos/Awak3r/it_proj/environments/production
```

В GitHub UI откройте **Settings → Environments → production → Deployment branches and tags** и разрешите только доверенную ветку **`codex/labturn-mvp`**. Проверьте ограничение и для уже существующей среды. Не выбирайте все ветки/произвольные теги. По возможности настройте required reviewers; доступность отдельных правил зависит от возможностей репозитория/тарифа. Если нужная защита недоступна, согласуйте это с владельцем, не обходите её молча.

### Отдельный CI SSH-ключ

Только **с согласия владельца** создайте на ПК отдельный Ed25519-ключ `~/.ssh/labturn_actions`. Он нужен исключительно Actions, без passphrase для неинтерактивного CI. Не используйте личный ключ владельца и не переносите приватный ключ с VPS.

Следующий блок не перезаписывает существующие файлы или symlink с этими именами:

```bash
if [[ -e ~/.ssh/labturn_actions || -L ~/.ssh/labturn_actions || -e ~/.ssh/labturn_actions.pub || -L ~/.ssh/labturn_actions.pub ]]; then
  printf '%s\n' 'Ключ уже существует: остановитесь и согласуйте его использование или ротацию.'
else
  mkdir -p ~/.ssh
  chmod 700 ~/.ssh
  (umask 077; ssh-keygen -t ed25519 -f ~/.ssh/labturn_actions -N '' -C labturn-actions)
  chmod 600 ~/.ssh/labturn_actions
fi
```

Если ключ уже существовал, не продолжайте регистрацию без проверки его назначения владельцем. Приватную часть **никогда не печатать, не отправлять в чат, не добавлять в Git, artifact или логи**. Не включайте shell tracing (`set -x`).

Публичную часть зарегистрируйте через **уже имеющийся пользовательский SSH-доступ** к VPS:

```bash
cat ~/.ssh/labturn_actions.pub | ssh ubuntu@92.5.236.71 /usr/local/sbin/labturn-authorize-ci-key
```

Эта команда передаёт только public key. Если SSH из WSL не работает, настройте существующий пользовательский ключ/agent отдельно; не копируйте ключ с сервера. Проверяйте host key по доверенному источнику, не отключайте его проверку.

Root-owned `/usr/local/sbin/labturn-authorize-ci-key` принимает только public `ssh-ed25519` через stdin и добавляет в `/home/ubuntu/.ssh/authorized_keys` запись с ограничениями:

```text
restrict,command="/usr/local/sbin/labturn-ci-ssh"
```

Остальные строки `authorized_keys` не меняются. Не заменяйте файл целиком и не регистрируйте ключ без forced command.

Приватную часть загрузите напрямую в environment secret, без вывода содержимого:

```bash
gh secret set VPS_SSH_KEY --env production --repo Awak3r/it_proj < ~/.ssh/labturn_actions
```

**Единственный настраиваемый CI secret — `VPS_SSH_KEY` в environment `production`**, не repository-level secret. Production `.env`, bot token, пароль БД и личные SSH-ключи GitHub не передаются. Встроенная авторизация Actions для checkout/artifact не требует нового пользовательского токена.

## 3. Что разрешено CI на VPS

VPS: `ubuntu@92.5.236.71`. Публичный `.github/vps_known_hosts` фиксирует ED25519 host key сервера; workflow должен пользоваться им с обязательной проверкой host key. Не заменяйте pin на безусловный `ssh-keyscan` и не используйте `StrictHostKeyChecking=no`. При смене ключа сначала независимо подтвердите новый ключ у владельца.

Root-owned forced-command dispatcher `/usr/local/sbin/labturn-ci-ssh` разрешает **только**:

```text
labturn-check
labturn-deploy labturn-app:gh-<40hex SHA>-<run_id>-<attempt>
```

Это описание разрешённого протокола workflow, не инструкция для ручной публикации. CI-ключ не предназначен для интерактивного shell, произвольных команд, SCP/SFTP или обычного администрирования. Для операционных чтений используется отдельный пользовательский SSH-доступ.

Установленный root receiver `/usr/local/sbin/labturn-deploy-image`:

- Проверяет gzip `docker-save` manifest, ожидаемый тег, архитектуру и production-конфигурацию.
- Перед переключением выполняет backup через `/usr/local/sbin/labturn-backup` и сохраняет прежний образ.
- Обновляет только `app` с `--no-deps --no-build --pull never --wait`; проверяет health/config/auth/static.
- При неудаче откатывает **образ**, но **не миграции/данные БД**.

`compose.production.yaml` сбрасывает `build`, задаёт `image: ${LABTURN_IMAGE}` и `pull_policy: never`. `scripts/compose-production.sh` читает серверные `.env` и `../ops/image.env`; в последнем находится только `LABTURN_IMAGE`. На VPS ничего не собирается. Образы остальных сервисов и volumes при app-only deploy не меняются.

Перезапуск app кратковременно прерывает обслуживание/SSE; reconnect ожидается. **Zero downtime не обещается.** Миграции должны оставаться совместимыми с прежним образом. Backup не означает автоматического восстановления БД; такое восстановление согласовывается отдельно с учётом потери новых записей.

## 4. Сохранение сервера и данных

| Объект | Назначение и ограничения |
| --- | --- |
| `/home/ubuntu/labturn/source` | Оставить на VPS: Compose, Caddyfile и `.env` нужны для эксплуатации. Не удалять после переноса разработки. |
| `/home/ubuntu/labturn/source/.env` | Только сервер, права `600`; не читать для локальной настройки, не копировать на ПК/GitHub, не выводить Compose config с раскрытыми секретами. |
| `/home/ubuntu/labturn/ops` | Серверные служебные файлы, выбор образа и эксплуатационные проверки. Не переносить целиком как исходники. |
| `/var/backups/labturn` | Root-owned, каталог `700`; ежедневный backup с хранением 7 дней, восстановление проверено. |
| Docker volumes | Существующие production-данные сохраняются. `down -v`, очистка volumes и destructive reset запрещены. |

**Offsite backup пока не настроен.** Локальные копии на VPS не защищают от потери самого сервера. Настройку offsite выполнить отдельной согласованной задачей, не включать дампы в Git или CI artifacts.

На VPS не запускать сборки, seed, UI-тесты, IDE или language servers. После переноса владелец вручную закрывает remote Zed; не убивать его действующее соединение.

## 5. Проверка прогона и эксплуатационные чтения

После push:

```bash
gh run list --repo Awak3r/it_proj --workflow deploy.yml --branch codex/labturn-mvp --limit 5
```

Выберите фактический run ID из вывода; не подставляйте вымышленный. Через UI или `gh run view` проверьте commit SHA, успешные checks/build, artifact и **отдельно deployment job**. Ожидание environment approval или ошибка deploy не равны успешной публикации. Не публикуйте необработанные логи, если они могут содержать чувствительные данные.

Разрешённые операционные чтения с пользовательским, не CI-ключом:

```bash
curl --fail https://labturn.awak3r.ru/api/health
ssh ubuntu@92.5.236.71 'cd /home/ubuntu/labturn/source && bash scripts/compose-production.sh ps'
ssh ubuntu@92.5.236.71 'cd /home/ubuntu/labturn/source && bash scripts/compose-production.sh logs --tail 100 app'
```

Не запускайте вручную receiver для обхода неуспешного workflow. При ошибке проверьте результат rollback и фактический статус, затем исправляйте процесс через согласованный push/повтор Actions. Реальный Telegram-вход и телефонная safe-area проверка требуют участия владельца; CI этого не заменяет.

## 6. Незавершённые шаги на момент передачи

- GitHub ещё не содержит нового опубликованного commit/release. Родитель готовит два коммита и push в `codex/labturn-mvp`; фактические SHA нужно проверить после push.
- На VPS нет готовых Git push credentials. Владельцу передан **публичный временный read-write GitHub deploy key** с просьбой добавить его в репозиторий. Это ключ для исходящего push с VPS в GitHub, **не** CI-ключ для входа Actions на VPS. После успешного push родитель удалит временный private key с VPS; дальнейший отзыв публичного deploy key согласовать с владельцем.
- Пользовательская авторизация `gh`, environment/branch restrictions и secret `VPS_SSH_KEY` на ПК не предполагаются настроенными: подтвердить их отдельно.
- Первый успешный Actions deploy, локальная WSL-среда и телефон после CSS safe-area патча ещё должны быть подтверждены.

Не устраняйте эти блокеры force push, merge в `main`, созданием новой ветки без спроса или переносом production-секретов.
