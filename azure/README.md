# Deploying z-agent-native on a VM (Azure B2s and friends)

Two files do the work:

| File | Purpose |
| --- | --- |
| `azure/cloud-init.yaml` | Paste into **Advanced → Custom data** when creating the VM. On first boot it installs Docker, clones the repo and runs the provisioner. |
| `azure/provision.sh` | The provisioner itself. Idempotent, safe to re-run, also usable on any existing Ubuntu 24.04 VM. |

Nothing else is manual: keys, firewall, TLS and the stack start on their own.

---

## Before you start: the Azure eligibility gate

**Azure for Students requires an institutional email address from an accredited, degree-granting
institution.** A GitHub Student Developer Pack subscription does *not* activate Azure — signing in
with GitHub only authenticates you, the academic check still runs against a school email. This is
the most common failure mode ("Something went wrong. We are investigating." / "Unable to confirm
your University ID").

So:

- **You have a university/college email** → continue with the steps below.
- **You do not** → Azure for Students is closed to you. Jump to [Fallbacks](#fallbacks-when-there-is-no-school-email).

Verification itself (identity, phone code, terms) must be done by you — it is tied to your name and
cannot be delegated. Everything *after* the subscription exists is automated here.

## 1. Activate Azure for Students

1. Add your school email as **primary** in GitHub → Settings → Emails, verify it.
2. Open `https://signup.azure.com/studentverification?offerType=1`.
3. Click **Sign in with GitHub** and log in with your **GitHub username** (not the email).
4. Complete phone verification (SMS or call). No credit card is requested.
5. You get **$100 of credit for 12 months**, renewable while you are a student.

If the check loops, open an InPrivate window, sign out of every Microsoft and GitHub account, and
retry; that is the path that most often works. Support: `azureforeducation.microsoft.com`.

## 2. Create the VM

Portal → **Create a resource → Virtual machine**:

| Field | Value |
| --- | --- |
| Subscription | Azure for Students |
| Resource group | new, e.g. `z-agent-rg` |
| Region | **Germany West Central** (close to Aachen) |
| Image | **Ubuntu Server 24.04 LTS — x64 Gen2** |
| Size | **Standard_B2s** — 2 vCPU, 4 GiB |
| Authentication type | **SSH public key** |
| Username | `azureuser` |
| SSH public key | paste your public key (see below) |
| Public inbound ports | **SSH (22), HTTP (80), HTTPS (443)** |
| OS disk | Standard SSD, 30 GiB is enough (raise to 64 GiB if you build a lot) |

**Advanced tab → Custom data:** paste the entire contents of `azure/cloud-init.yaml`.
Set `Z_AGENT_DOMAIN` there if you own a domain, otherwise leave it empty.

No SSH key yet? In the portal, on the VM page after creation, use **Run command → RunShellScript**
to get a shell without any local SSH client — handy from a phone. If you prefer a real client on
Android, Termux (`pkg install openssh`) works fine.

## 3. Wait ~5 minutes

The VM boots, cloud-init installs Docker, clones the repo, generates keys, opens the firewall,
builds the images and starts six containers (runtime, executor, browser, browser egress proxy, SearXNG and Caddy). Then:

```bash
ssh azureuser@<public-ip>
sudo cat /root/z-agent-info.txt      # URL + invite code
sudo tail -f /var/log/z-agent-provision.log
```

Everything from step 3 onward happens without you. The first build takes a few minutes; the
provisioner prints a health line from the runtime when the app answers, and a second line when the
TLS certificate is live.

## 4. First login

1. Open `https://<Z_AGENT_DOMAIN>`.
2. Register with the **invite code** from `/root/z-agent-info.txt` — the first account becomes
   administrator.
3. **Настройки → «Модели и API-ключи»** (Settings → Models) → add a model provider key. Free options without a card:
   Google AI Studio (Gemini, 1 500 req/day), Groq (14 400 req/day), OpenRouter (`:free` models).
   Keys are stored encrypted in `data/`, never in `.env`.

---

## Cost and guardrails

`Standard_B2s` plus a 30 GiB disk and a public IP runs roughly **$35–40/month** if left on 24/7,
so $100 lasts about **2.5–3 months**. Turn the VM off when you are not testing and it stretches
much further.

Do these two things on day one:

1. **Cost Management → Budgets → Add**: amount `$80`, alert at 80% and 100%. The subscription does
   not auto-charge a card (there is none), but the credit can silently run dry and shut the VM down.
2. **VM → Auto-shutdown**: e.g. `02:00` Europe/Berlin, on. Skip this only if you need the agent
   running overnight.

Useful commands on the VM:

```bash
cd /opt/z-agent-native
sudo docker compose ps                       # what is running
sudo docker compose logs -f z-agent          # runtime logs
sudo bash azure/provision.sh                 # re-run: update + restart, keys are preserved
sudo docker compose exec z-agent node server/backup.mjs /data/backups/z-agent-$(date +%F).sqlite   # SQLite snapshot + signed manifest (the host has no npm)
```

## What the provisioner deliberately does not do

- It does not expose port 3000. `docker-compose.override.yml` binds the runtime to
  `127.0.0.1:3002`; only Caddy is public, and only on 80/443.
- It does not set `Z_AGENT_ALLOW_UNISOLATED_SHELL=1`. On a host reachable from the Internet the
  Docker executor is the isolation boundary — keep it that way.
- It does not open `/metrics`; the Caddyfile answers 404 there on purpose.

`Z_AGENT_PROFILE=trusted` (the default here) enables the terminal, outbound agent network, SSH and
installers for a **single-user** host — appropriate for your own test stand. Use `hardened` if the
machine is ever shared with other people.

## Сеть агента на публичном хосте

`Z_AGENT_PROFILE=trusted` (умолчание провижинера) ставит `Z_AGENT_NETWORK_POLICY=public`: агент ходит
на любой хост. Для однопользовательской машины это удобно, но у публичного IP есть обратная
сторона — агент исполняет код, и открытая сеть работает каналом для выноса данных. Компромисс без
потери функций — `allowlist`: агент ходит только на перечисленные хосты, поиск и чтение страниц
остаются.

```bash
cd /opt/z-agent-native
sudo sed -i 's|^Z_AGENT_NETWORK_POLICY=.*|Z_AGENT_NETWORK_POLICY=allowlist|' .env
sudo sed -i 's|^Z_AGENT_NETWORK_ALLOWLIST=.*|Z_AGENT_NETWORK_ALLOWLIST=api.open-meteo.com,html.duckduckgo.com,api.duckduckgo.com,*.wikipedia.org|' .env
sudo docker compose up -d --remove-orphans     # пересоздаёт контейнер с новым .env
curl -fsS "https://$(grep -E '^Z_AGENT_DOMAIN=' .env | cut -d= -f2)/health"
```

Проверить, что агент это видит, можно из логов или так:

```bash
sudo docker compose exec z-agent node --input-type=module -e \
  'import { runtimeCapabilityPrompt } from "/app/server/native/workspace-policy.mjs"; console.log(runtimeCapabilityPrompt())'
# ожидаем: "Internet: limited to these hosts: api.open-meteo.com, ..."
```

Что стоит знать про этот режим:

- Хост в списке — точное совпадение; поддомены нужно разрешать явно (`*.wikipedia.org`).
- Если в стеке есть SearXNG (`Z_AGENT_SEARXNG_URL`, контейнер `z-agent-search`), `websearch` идёт через
  него раньше DuckDuckGo (порядок: Brave при наличии ключа → SearXNG → DuckDuckGo HTML → Instant Answer + Wikipedia),
  и сам SearXNG — внутренний сервис, ему хосты из списка не нужны. Но входная проверка `websearch` всё равно
  требует, чтобы в списке был `api.duckduckgo.com` (или `api.search.brave.com`, если задан `BRAVE_SEARCH_API_KEY`) —
  поэтому он есть в рекомендованном наборе выше. Остальные хосты добавляйте, когда нужны `webfetch` или браузер.
- Браузер подчиняется тому же списку: открыть произвольный сайт в allowlist-режиме нельзя,
  инструмент вернёт отказ политики, а не ошибку браузера.
- Оболочка (`Z_AGENT_SHELL_NETWORK_POLICY`) — отдельный переключатель; в профиле `hardened`
  автономный исполнитель вообще без сети, что и есть граница изоляции.
- Вернуться к полному доступу: `Z_AGENT_NETWORK_POLICY=public` + `Z_AGENT_ALLOW_PUBLIC_WEB=1`.

## Fallbacks when there is no school email

| Option | Cost | Card | Notes |
| --- | --- | --- | --- |
| **GitHub Codespaces** | $0 | no | Works today, student account gets Pro-level hours. Sleeps when idle, deleted after 30 days of inactivity — a dev environment, not a server. |
| **ClawCloud Run** | $0 ($5/month credit) | no | Needs a GitHub account older than 180 days. The account here is from 21 Jun 2026, so it opens around **18 Dec 2026**. |
| **Hetzner CX22** | ~€4.35/mo | **not required** — SEPA direct debit or PayPal | 2 vCPU / 4 GB / 40 GB NVMe, exactly the shape the compose profile was written for. Run the same `azure/provision.sh`; it is not Azure-specific. |
| Oracle / Google / AWS free tiers | $0 | **required** | The best free specs, but they verify with a card. |

`provision.sh` is plain Ubuntu automation — it works unchanged on Hetzner, on ClawCloud's VMs, or
on any other VPS you end up with.
