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

# The shipped template disables model-selected network egress, so the agent
# answers "Internet: disabled for this instance" and refuses to browse or fetch
# pages. That is the right default for an Internet-facing server and the wrong
# one for a private codespace, so enable the documented "trusted" profile here.
# Set Z_AGENT_STRICT_NETWORK=1 to keep the hardened defaults instead.
if [ "${Z_AGENT_STRICT_NETWORK:-0}" != "1" ]; then
  set_env Z_AGENT_NETWORK_POLICY public
  set_env Z_AGENT_ALLOW_PUBLIC_WEB 1
  set_env Z_AGENT_SHELL_NETWORK_POLICY open
  set_env Z_AGENT_ALLOW_NETWORKED_INSTALLERS 1
  set_env Z_AGENT_ALLOW_PRODUCTION_TERMINAL 1
fi

# Codespaces secrets (repository settings -> Secrets and variables ->
# Codespaces) arrive as environment variables and win over .env when the
# runtime starts -- but only for processes started by the lifecycle hooks.
# A terminal or a manual `npm start` sees .env instead, which would silently
# use a different invite code and different encryption keys. Mirror the
# secrets into .env so every path agrees.
for key in Z_AGENT_SECRET_KEY Z_AGENT_AUDIT_KEY Z_AGENT_INVITE_CODE; do
  value="${!key:-}"
  if [ -n "$value" ]; then
    set_env "$key" "$value"
  fi
done

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

# ------------------------------------------------------- browser tool support
# The agent's browser tool drives a real Chromium through playwright. Without a
# downloaded build plus its system libraries the tool fails with "Executable
# doesn't exist" or crashes at launch, which looks like a policy problem and is
# not. This step is skipped once the browser is present.
# Set Z_AGENT_SKIP_BROWSER=1 to skip it (saves ~150 MB and a minute of setup).
if [ "${Z_AGENT_SKIP_BROWSER:-0}" != "1" ]; then
  BROWSERS_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if [ -z "$(ls -A "$BROWSERS_DIR" 2>/dev/null)" ]; then
    echo "[setup] installing Chromium for the agent browser tool (~150 MB)..."
    npx playwright-core install chromium >/dev/null 2>&1 \
      || echo "[setup] WARN: Chromium download failed; run: npx playwright-core install chromium"
    # System libraries (libnss3, xvfb and friends) are not in the base image.
    NPX_BIN="$(command -v npx || true)"
    if [ -n "$NPX_BIN" ]; then
      sudo env "PATH=$PATH" "$NPX_BIN" playwright-core install-deps chromium >/dev/null 2>&1 \
        || echo "[setup] WARN: Chromium system dependencies failed; run: sudo npx playwright-core install-deps chromium"
    fi
  fi
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
