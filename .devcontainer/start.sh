#!/usr/bin/env bash
# Starts the z-agent-native runtime inside a Codespace.
#
# Runs as postStartCommand and postAttachCommand, so it must be idempotent:
# if the server already answers /health it does nothing.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-3000}"
LOG="${Z_AGENT_START_LOG:-/tmp/z-agent-server.log}"

healthy() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

if healthy; then
  echo "[start] z-agent already running on :${PORT}"
else
  if [ ! -f .env ]; then
    echo "[start] .env missing — run: bash .devcontainer/setup.sh"
    exit 0
  fi
  [ -d dist ] || npm run build

  echo "[start] starting z-agent (log: ${LOG})"
  nohup npm start >"$LOG" 2>&1 &

  for _ in $(seq 1 45); do
    sleep 1
    healthy && break
  done

  if healthy; then
    echo "[start] z-agent is up on port ${PORT}"
  else
    echo "[start] WARN: health check did not pass in 45s; last log lines:"
    tail -20 "$LOG" 2>/dev/null || true
  fi
fi

INVITE="$(sed -n 's/^Z_AGENT_INVITE_CODE=//p' .env 2>/dev/null | tail -1)"
cat <<EOF

  Open the UI:  Ports tab -> 3000 -> Open in Browser
  Invite code:  ${INVITE:-<not set>}   (also in ~/.z-agent-invite)
  Logs:         tail -f ${LOG}
  Restart:      pkill -f 'server/index.mjs' ; bash .devcontainer/start.sh

  Running as a trusted single-user host (Z_AGENT_ALLOW_UNISOLATED_SHELL=1).
  Keep port ${PORT} on private visibility: this process executes code.
EOF
