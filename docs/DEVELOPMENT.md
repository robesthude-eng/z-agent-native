# Разработка и обновление проекта

Практический цикл работы над z-agent-native: как править код, как проверять, как обновлять
окружение и как обновлять сервер.

---

## 1. Ежедневный цикл (Codespace)

Codespace — это ваша машина разработки: 2 ядра / 8 ГБ, Docker, Node 24, всё уже настроено.
Работать можно и с телефона: редактор открывается в браузере.

```
1. Открыть Codespace          →  github.com/codespaces → «z-agent»
2. Править код                →  редактор VS Code прямо в браузере
3. Перезапустить и проверить  →  команды ниже
4. Прогнать проверки          →  npm run quality:quick
5. Закоммитить и запушить     →  git … (см. ниже)
6. Открыть PR и смержить      →  squash-merge после зелёного CI
```

### Перезапуск приложения после правок

```bash
pkill -f '[i]ndex.mjs'            # квадратные скобки — чтобы не убить свою же сессию
bash .devcontainer/start.sh       # поднимет и дождётся /health
tail -f /tmp/z-agent-server.log   # логи в реальном времени
```

### Режим разработки с живой перезагрузкой фронтенда

Если правите интерфейс, удобнее два процесса — Vite перезагружает страницу сам:

```bash
# терминал 1
npm run dev:server                # рантайм + API на 3000

# терминал 2
npm run dev:web                   # Vite на 5173, проксирует /api, /health, /socket.io на 3000
```

Порт 5173 появится во вкладке **Ports** — открывайте его, а не 3000.

### Проверки перед коммитом

```bash
npm run quality:quick   # typecheck + architecture + lint + format + тесты + доки  (быстро)
npm run quality         # то же плюс native-тесты и сборка фронтенда           (полно)
npm test                # только тесты
npm run lint:ci         # то, что запускает CI
npm run format:check    # то, что запускает CI
```

CI требует, чтобы `lint:ci` и `format:check` были зелёными. Если правили `.json` —
прогоните `npm run format`, biome сам поправит отступы.

### Коммит и отправка

```bash
git checkout -b feature/korotkoe-imya     # отдельная ветка, не main
git add -A
git commit -m "feat(agent): описание изменения"
git push -u origin feature/korotkoe-imya
```

GitHub напечатает в ответ ссылку вида `…/pull/new/feature/…` — откройте её, опишите изменение,
дождитесь зелёного CI и нажмите **Squash and merge**.

---

## 2. Правила ветки main

`main` защищена — это не мешает, а помогает:

| Правило | Что значит на практике |
|---|---|
| **Линейная история** | только `Squash` или `Rebase and merge`. Кнопка «Create a merge commit» не сработает |
| Запрет force-push | историю нельзя перезаписать — то, что попало в main, остаётся |
| Запрет удаления | ветку main нельзя снести |
| CI (7 проверок) | гоняются на каждый PR: lint, формат, typecheck, тесты, e2e, безопасность зависимостей, контракт контейнера |

Прямой пуш в `main` администратором технически возможен, но лучше не привыкать: PR + CI — это
то, что защищает рабочий стенд от случайной поломки.

---

## 3. Секреты и данные

| Что | Где живёт | В git попадает? |
|---|---|---|
| `.env` (ключи шифрования, invite-код) | корень проекта | ❌ в `.gitignore` |
| `data/` (SQLite: аккаунты, чаты, история) | `data/z-agent.sqlite` | ❌ в `.gitignore` |
| Ключи провайдеров моделей | шифруются в `data/`, задаются в UI → Settings → Providers | ❌ |
| Codespaces-секреты | настройки репозитория → Secrets and variables → Codespaces | ❌ |

**Никогда не коммитьте** `.env` и `data/`. Если случайно закоммитили ключ — он уже в истории,
и правильный выход — **отозвать ключ у провайдера**, а не переписывать историю.

### Резервная копия

```bash
npm run db:backup -- /workspaces/backup-$(date +%F).sqlite     # копия базы + цепочка аудита
```

Codespace без активности 30 дней — удаляется. Перед длинными паузами делайте бэкап.

---

## 4. Обновление окружения Codespace

| Что изменилось | Что делать |
|---|---|
| Файлы `.mjs`, фронтенд (`src/`) | `git pull` → перезапустить приложение |
| `.devcontainer/*`, `.vscode/*` | нужен **Rebuild**: палитра команд (Ctrl+Shift+P) → «Codespaces: Rebuild Container», либо `gh cs rebuild -c <имя>` |
| `.env.example` (новые переменные) | после rebuild: сверить `.env` с новым шаблоном вручную |

Пересборка сохраняет `data/` и ваш `.env`, но бэкап перед ней — хорошая привычка.

---

## 5. Обновление сервера (когда появится VM)

```bash
ssh user@<ip>
cd /opt/z-agent-native
sudo git pull
sudo docker compose up --build -d
sudo docker compose ps
```

Или одной командой — провижининг идемпотентный, ключи и `.env` он не трогает:

```bash
sudo Z_AGENT_DIR=/opt/z-agent-native bash azure/provision.sh
```

Перед обновлением:

```bash
npm run db:backup -- /root/z-agent-$(date +%F).sqlite
```

Откат к предыдущему состоянию: `git log --oneline`, затем `git checkout <коммит>` и снова
`docker compose up --build -d`.

---

## 6. Интернет и браузер у агента

Установка по умолчанию идёт в «закрытом» профиле: агенту запрещён выбор адресов в сети. Тогда на
просьбу посмотреть погоду или открыть страницу он честно отвечает, что интернета нет —
это политика, а не поломка. В Codespace она уже открыта; на сервере включайте осознанно.

Что именно проверяется (видно в `server/native/workspace-policy.mjs`):

| Переменная | Закрыто (по умолчанию) | Список хостов | Открыто (доверенный хост) |
|---|---|---|---|
| `Z_AGENT_NETWORK_POLICY` | `off` | `allowlist` | `public` |
| `Z_AGENT_NETWORK_ALLOWLIST` | — | `api.open-meteo.com,*.wikipedia.org` | — (весь публичный веб) |
| `Z_AGENT_ALLOW_PUBLIC_WEB` | `0` | `0` | `1` — обязательное подтверждение |
| `Z_AGENT_SHELL_NETWORK_POLICY` | `guarded` | `guarded` | `open` (curl, wget, git, пакеты) |
| `Z_AGENT_ALLOW_NETWORKED_INSTALLERS` | `0` | `0` | `1` (npm/pip внутри сессии) |
| `Z_AGENT_ALLOW_PRODUCTION_TERMINAL` | `0` | `0` | `1` — нужен, если включён терминал |

**Три режима — выбирайте по тому, кто может дотянуться до хоста.**

- `off` — по умолчанию, для чужих и многопользовательских стендов.
- `allowlist` — **рекомендуемый режим для сервера с публичным IP.** Агент ходит только на
  перечисленные хосты (`*.example.com` разрешает поддомены, голый `example.com` — только сам хост),
  всё остальное отклоняется политикой. Данные некуда слить, а поиск и чтение страниц работают.
  Готовый набор для обычных задач:

  ```
  Z_AGENT_NETWORK_POLICY=allowlist
  Z_AGENT_NETWORK_ALLOWLIST=api.open-meteo.com,html.duckduckgo.com,api.duckduckgo.com,*.wikipedia.org
  ```

  Сообщение агента в этом режиме: «Internet: limited to these hosts: … Other hosts are refused by
  policy, not by you» — то есть он не соврёт, что интернета нет, и не будет обещать открыть любой сайт.
- `public` — любой публичный хост. Только для однопользовательской машины, куда снаружи не
  дотянуться; на публичном хосте агент исполняет код, и открытая сеть становится каналом утечки.

После правки `.env` перезапустите рантайм. Проверить, что агент действительно видит интернет:

```bash
node --env-file-if-exists=.env --input-type=module -e \
  'import { runtimeCapabilityPrompt } from "./server/native/workspace-policy.mjs"; console.log(runtimeCapabilityPrompt())' \
  | grep -i internet
# public:    "Internet: enabled. websearch, webfetch and browser reach any public host."
# allowlist: "Internet: limited to these hosts: <список>."
# off:       "Internet: disabled for this instance."
```

**Браузерный инструмент — отдельная история.** Ему нужен настоящий Chromium, которого нет в базовом
образе. В Codespace это ставится автоматически при настройке; вручную:

```bash
npx playwright-core install chromium
sudo env "PATH=$PATH" "$(command -v npx)" playwright-core install-deps chromium
```

Симптом отсутствия браузера — `Executable doesn't exist at .../chrome-headless-shell` или
`Target page, context or browser has been closed` при запуске. `websearch` и `webfetch` браузера не
требуют: они ходят напрямую (DuckDuckGo HTML, либо ваш `Z_AGENT_SEARXNG_URL`).

⚠️ Сеть — это канал утечки: агент исполняет код, поэтому на хосте с публичным IP выбирайте
`allowlist`, а не `public`. Профиль `trusted` из `scripts/init-production-env.mjs` включает именно
`public` — он для однопользовательской машины за закрытым периметром. Инструкция по замене профиля
после установки — в `azure/README.md`, раздел «Сеть агента на публичном хосте».

---

## 7. Работа с телефона

- **Редактор и терминал** — прямо в браузере, ссылка `https://<codespace>.github.dev`.
- **UI приложения** — вкладка Ports → 3000 (или публичная ссылка, если вы её открыли:
  `gh codespace ports visibility 3000:public -c <имя>`; вернуть — `…:private`).
- **SSH с телефона** — Termius/Termux; хост и ключ выдаёт `gh codespace ssh --config`.
- Учтите: открытый порт = страница входа доступна всем, кому известна ссылка. В приложении
  нет защиты от перебора пароля, поэтому пароль должен быть длинным. Закрыть регистрацию:
  убрать переменную `Z_AGENT_INVITE_CODE` (тогда новые аккаунты не создаются).

---

## 8. Карта проекта

| Каталог | Что внутри |
|---|---|
| `server/` | рантайм: агентный цикл, инструменты, API, SSE, терминал, SQLite |
| `server/native/` | ядро рантайма: конфиг, безопасность, сессии, провайдеры моделей |
| `src/` | фронтенд (React + Vite): трёхпанельный интерфейс |
| `tests/` | юнит- и интеграционные тесты (`npm test`, `npm run test:native`) |
| `e2e/` | Playwright-сценарии (`npm run test:e2e`) |
| `evals/` | оценка качества агента (`npm run eval:run`) |
| `docs/` | документация по инструментам, медиа, скиллам |
| `scripts/` | служебные скрипты: миграции, проверки, бенчмарки |
| `.devcontainer/` | окружение разработки (этот Codespace) |
| `azure/`, `deploy/` | развёртывание: провижининг VM, хостовые сервисы |

Ключевые документы: `README.md` (обзор), `ARCHITECTURE.md` (внутренности),
`SECURITY.md` (границы доверия), `OPERATIONS.md` (эксплуатация).

---

## 9. Шпаргалка

```bash
# запуск/остановка
bash .devcontainer/start.sh
pkill -f '[i]ndex.mjs'

# проверки
npm run quality:quick
npm run lint:ci && npm run format:check

# данные
npm run db:migrate
npm run db:backup -- /workspaces/backup-$(date +%F).sqlite

# git
git checkout -b feature/имя
git add -A && git commit -m "feat: …" && git push -u origin feature/имя

# диагностика Codespace
cat ~/.z-agent-start.log            # какие хуки запускали приложение
tail -50 /tmp/z-agent-server.log    # логи рантайма
gh cs ports -c <имя>                # видимость портов
```
