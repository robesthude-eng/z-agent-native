# llm-relay (Cloudflare Worker)

Direct-only LLM-релей: обходит гео-блокировки, направляя запросы к LLM-провайдерам
через egress Cloudflare Worker (сервер → воркер → провайдер).

## Routing
`/<SECRET>/<host>/<path>` пересылается на `https://<host>/<path>`. Метод, заголовки
(включая Authorization) и тело пробрасываются as-is, ответ стримится обратно.

## Деплой
1. Установить wrangler (`npm i -g wrangler`, Node 22+; либо `npx wrangler@3` для Node 20).
2. Авторизация: `wrangler login` или `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...`.
3. Задать секрет: `wrangler secret put SECRET` (для dev можно `vars` в `wrangler.toml`).
4. `wrangler deploy` из этой папки (нужен `wrangler.toml` с `main = "llm-relay.js"`, `workers_dev = true`).

## Подключение к z-agent-native
В `.env` на сервере:
```
Z_AGENT_RELAY_URL=https://<worker>.<subdomain>.workers.dev/<SECRET>
```
Приложение само обернёт любой endpoint провайдера через релей (`wrapProviderUrl`
в `server/native/providers.mjs`). Сам `SECRET` в репозитории не хранится.
