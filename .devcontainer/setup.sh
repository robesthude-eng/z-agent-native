#!/usr/bin/env bash
# Codespaces / devcontainer setup for z-agent-native.
#
# Runs as postCreateCommand. Idempotent: safe to re-run at any time.
# Generates per-codespace secrets locally; nothing here is committed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "[setup] z-agent-native dev environment"
echo "[setup] node $(node --version 2>/dev/null || echo missing), npm $(npm --version 2>/dev/null || echo missing)"

# ------------------------------------------------------------------ tools
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[setup] installing sqlite3..."
  (sudo apt-get update -qq && sudo apt-get install -y -qq sqlite3) \
    || echo "[setup] WARN: sqlite3 install skipped"
fi

# ------------------------------------------------------------ dependencies
echo "[setup] npm ci (a few minutes the first time)..."
npm ci --no-audit --no-fund || npm install --no-audit --no-fund || {
  echo "[setup] FATAL: dependency install failed"
  exit 1
}

# ------------------------------------------------------------------- .env
if [ ! -f .env ]; then
  echo "[setup] creating .env with a fresh invite code"
  cp .env.example .env
fi

# .env.example ships every key, sometimes empty; appending a second copy of a
# key would leave two conflicting lines, and which one wins depends on the
# reader. Always collapse a key to exactly one line.
read_env() {
  sed -n "s/^$1=//p" .env | tail -1
}

set_env() {
  local key="$1" value="$2"
  grep -v "^${key}=" .env > .env.tmp 2>/dev/null || true
  mv .env.tmp .env
  printf '%s=%s\n' "$key" "$value" >> .env
}

# A codespace is a trusted, single-user development host: the interactive
# terminal and the local shell are expected to work without the Docker
# executor. Never copy these two lines onto a shared or Internet-facing host.
set_env Z_AGENT_ALLOW_UNISOLATED_SHELL 1
set_env Z_AGENT_TERMINAL_ENABLED 1

# Invite code is required for registration, including the first account.
if [ -z "$(read_env Z_AGENT_INVITE_CODE)" ]; then
  INVITE="$(openssl rand -hex 12 2>/dev/null \
    || node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
  set_env Z_AGENT_INVITE_CODE "$INVITE"
  echo "[setup] invite code generated"
fi
INVITE="$(read_env Z_AGENT_INVITE_CODE)"
printf '%s\n' "$INVITE" > "$HOME/.z-agent-invite"
chmod 600 "$HOME/.z-agent-invite" 2>/dev/null || true

# ---------------------------------------------------------------- database
echo "[setup] database schema..."
npm run db:migrate || echo "[setup] WARN: db:migrate returned non-zero"

# Optional: import an existing database + provider channels before first use.
# Set USER_IMPORT_SQL to a base64-encoded SQL script in Codespaces secrets.
if [ -n "${USER_IMPORT_SQL:-}" ] && command -v sqlite3 >/dev/null 2>&1; then
  echo "[setup] importing USER_IMPORT_SQL..."
  printf '%s' "$USER_IMPORT_SQL" | base64 -d | sqlite3 data/z-agent.sqlite \
    && echo "[setup] import OK" || echo "[setup] WARN: import failed"
fi

# ------------------------------------------------------------------- build
if [ ! -d dist ]; then
  echo "[setup] building frontend..."
  npm run build || echo "[setup] WARN: build failed"
fi

cat <<EOF

[setup] DONE

  Start:   bash .devcontainer/start.sh   (also runs automatically on start)
  UI:      port 3000 -> "Ports" tab -> open in browser
  Invite:  cat ~/.z-agent-invite
  Logs:    tail -f /tmp/z-agent-server.log

  Model provider keys go to Settings -> Providers after your first login.
  Free keys without a card: Google AI Studio, Groq, OpenRouter.
EOF
