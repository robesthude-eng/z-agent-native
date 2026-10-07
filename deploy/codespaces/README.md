# Running Z Agent Native in a GitHub Codespace

A Codespace is a free 2 vCPU / 8 GB Ubuntu machine attached to this repository. It is the
cheapest way to run and develop this stack without owning a credit card, and the compose
file in this repo is already sized for a 2 vCPU / 3.8 GB host.

## Create the Codespace

1. Open the repository on github.com.
2. **Code → Codespaces → Create codespace on main**.
3. Accept the 2-core / 8 GB machine.
4. Wait for `postCreateCommand` (`.devcontainer/setup.sh`) to finish — it runs `npm ci`,
   `npm run db:migrate` and creates `data/`.

The devcontainer installs Node 24 and Docker-in-Docker, so the full hardened compose
profile works inside the Codespace.

## Path A — plain runtime (fastest)

Use this for UI work and for running the agent loop itself. The isolated executor and
browser services are not started, so shell/terminal fall back to the local runtime.

In a Codespace you normally do not need the commands below: `.devcontainer/setup.sh` (postCreate) already creates `.env`, generates the keys and an invite code (saved to `~/.z-agent-invite`), enables the unisolated shell/terminal fallback and the open network profile (set `Z_AGENT_STRICT_NETWORK=1` before the first setup to keep the hardened defaults), and `.devcontainer/start.sh` starts the runtime on every start/attach (log: `/tmp/z-agent-server.log`, trace: `~/.z-agent-start.log`). The manual steps are for any other machine:

```bash
cp .env.example .env
# required for the local fallback, never do this on a public host:
printf '\nZ_AGENT_ALLOW_UNISOLATED_SHELL=1\nZ_AGENT_TERMINAL_ENABLED=1\n' >> .env
printf 'Z_AGENT_INVITE_CODE=%s\n' "$(openssl rand -hex 12)" >> .env

npm run build
npm start          # serves http://localhost:3000
```

Register the first account with the invite code you generated; it becomes the administrator.
The forwarded port 3000 gives you a browser URL for the UI.

Provider keys are configured in **Settings** and stored encrypted in `data/`, never in `.env`.

## Path B — full Docker stack (hardened profile)

This is what production runs: the trusted orchestrator plus the networkless executor,
the isolated Chromium service, the egress proxy and SearxNG.

```bash
npm run prod:env:init                 # writes .env (0600) with generated keys + invite code
npm run prod:env:init -- --profile=trusted   # single-user server: enables terminal/SSH/web

docker compose up --build -d
docker compose ps
```

Set `Z_AGENT_DOMAIN` to the host you will actually serve on. For a Codespace the forwarded
`*.app.github.dev` hostname works; keep the default hardened profile when the Codespace port
is public, because the trusted overlay is not meant for shared deployments.

Container memory caps (from `docker-compose.yml`): runtime 1g, executor 1g, browser 768m,
search 320m, egress 128m — about 3.2 GB total, so an 8 GB machine has headroom for builds.

## Limits to design around

| Limit | Free plan | Student (Pro-level Codespaces) |
| --- | --- | --- |
| Compute | 120 core-hours/month | higher personal allowance while verified |
| On a 2-core machine | 60 h/month | — |
| Storage | 15 GB-month | higher while verified |
| Idle shutdown | after ~30 min | same |

Codespaces stops itself when idle and **deletes the codespace after 30 days of inactivity**.
Treat it as a development environment: keep `data/` backups with
`npm run db:backup -- ../z-agent.sqlite` and move anything long-lived to a real VM.

## Moving to a real VM later

The same two commands (`npm run prod:env:init`, `docker compose up --build -d`) are all that
run on a server. Minimum shape: **2 vCPU / 4 GB RAM / 40 GB disk**, Docker Engine + Compose v2.

- Azure for Students (via GitHub Education / Student Developer Pack) gives $100 of credit with
  no credit card; `Standard_B2s` is exactly 2 vCPU / 4 GB.
- Any €4-class VPS (Hetzner CX22 / CAX11 and similar) matches the compose profile's own sizing.

Point `Z_AGENT_DOMAIN` at the server, terminate TLS with the supplied `Caddyfile`, and keep
`Z_AGENT_ALLOW_UNISOLATED_SHELL=0` on anything that is reachable from the Internet.
