---
name: z-agent-ops
description: Operate, restart, verify, back up and update a z-agent-native deployment running in a GitHub Codespace or on a VM. Use when asked to start or restart the app, check service health, inspect logs, make or restore a database backup, enable or disable registration, adjust port visibility, or update a server to the latest main.
license: MIT
---

# Operating z-agent-native

## Where things live

| Thing | Path |
| --- | --- |
| Runtime state, SQLite, audit chain | `data/` |
| Build output served by the runtime | `dist/` |
| Environment and generated keys | `.env` (mode 0600) |
| Runtime log | `/tmp/z-agent-server.log` |
| Start-hook trace | `~/.z-agent-start.log` |
| Invite code | `~/.z-agent-invite`, or `Z_AGENT_INVITE_CODE` in `.env` |

## Start, restart, verify

```bash
# restart (quote the pattern, or pkill matches its own command line and kills the session)
pkill -f '[i]ndex.mjs'
bash .devcontainer/start.sh

# verify: expect {"status":"ok", ...} and every check true
curl -s http://127.0.0.1:3000/health

# logs
tail -f /tmp/z-agent-server.log
cat ~/.z-agent-start.log          # which lifecycle hook started the runtime
```

`start.sh` is idempotent: if `/health` already answers it does nothing. Wait for the runtime
rather than restarting in a loop.

## Frontend development

```bash
npm run dev:server   # terminal 1: runtime and API on 3000
npm run dev:web      # terminal 2: Vite on 5173 with HMR, proxies /api, /health, /socket.io
```

Open 5173, not 3000, while `dev:web` runs.

## Database

```bash
npm run db:migrate
npm run db:backup -- /workspaces/backup-$(date +%F).sqlite    # includes the audit chain
```

Codespaces are deleted after 30 days of inactivity: back up `data/` before long pauses.

## Registration and access

- Registration requires `Z_AGENT_INVITE_CODE`; after the first account exists it is fail-closed.
- Close registration: clear `Z_AGENT_INVITE_CODE` in `.env` and restart.
- Port visibility (Codespaces): `gh codespace ports visibility 3000:public -c <name>` to open,
  `…:private` to require a GitHub login again. Keep it private by default: the runtime executes code.
- There is no login rate limiting, so any public deployment needs a long, unique password.

## Update the code

Codespace:

```bash
git pull
pkill -f '[i]ndex.mjs' && bash .devcontainer/start.sh
```

Rebuild the container only when `.devcontainer/` or `.vscode/` changed:
palette → "Codespaces: Rebuild Container", or `gh cs rebuild -c <name>`. `data/` and `.env` survive.

Server:

```bash
cd /opt/z-agent-native && sudo git pull && sudo docker compose up --build -d
```

## Checks before committing

```bash
npm run quality:quick    # typecheck, architecture, lint, format, tests, docs
npm run lint:ci && npm run format:check    # exactly what CI gates on
```

CI requires a green "Lint and formatting" job; `main` accepts squash merges only.

## Known traps

- Duplicate keys in `.env` (template plus appended lines) silently win or lose unpredictably:
  keep exactly one line per key.
- Codespaces secrets reach lifecycle hooks but not terminal sessions; mirror them into `.env`
  so a manual start and an auto-start share one invite code and one key set.
- A background process started from a lifecycle hook dies with the hook unless detached
  (`setsid`), which is why `start.sh` uses it.
- Never enable `Z_AGENT_ALLOW_UNISOLATED_SHELL=1` on an Internet-facing host: the Docker
  executor is the isolation boundary there.
