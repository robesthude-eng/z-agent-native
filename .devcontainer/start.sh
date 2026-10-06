#!/usr/bin/env bash
# Starts the z-agent-native runtime inside a Codespace.
#
# Invoked from postStartCommand, postAttachCommand and a folderOpen VS Code
# task, so it must be idempotent: if /health already answers, it does nothing.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-3000}"
LOG="${Z_AGENT_START_LOG:-/tmp/z-agent-server.log}"
TRACE="${Z_AGENT_START_TRACE:-$HOME/.z-agent-start.log}"

trace() {
  printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$TRACE" 2>/dev/null || true
}

healthy() {
  curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

trace "start.sh invoked (caller=${Z_AGENT_START_CALLER:-unknown})"

if healthy; then
  echo "[start] z-agent already running on :${PORT}"
  trace "already healthy, nothing to do"
else
  # postStartCommand can fire while postCreateCommand (setup.sh) is still
  # installing dependencies, so wait for the environment instead of giving up.
  if [ ! -f .env ]; then
    echo "[start] environment not provisioned yet — waiting for setup to finish..."
    for _ in $(seq 1 60); do
      [ -f .env ] && break
      sleep 5
    done
  fi

  if [ ! -f .env ]; then
    echo "[start] .env still missing — run: bash .devcontainer/setup.sh"
    trace "aborted: no .env"
    exit 0
  fi

  [ -d dist ] || npm run build

  echo "[start] starting z-agent (log: ${LOG})"
  # setsid detaches the server from the lifecycle command's process group:
  # a plain background job can be killed as soon as the hook shell exits.
  setsid nohup npm start >"$LOG" 2>&1 </dev/null &
  disown 2>/dev/null || true

  for _ in $(seq 1 45); do
    sleep 1
    healthy && break
  done

  if healthy; then
    echo "[start] z-agent is up on port ${PORT}"
    trace "server started and healthy"
  else
    echo "[start] WARN: health check did not pass in 45s; last log lines:"
    tail -20 "$LOG" 2>/dev/null || true
    trace "WARN: health check failed"
  fi
fi

# The environment wins over .env at runtime, so report what the process
# actually uses rather than what the file says.
INVITE="${Z_AGENT_INVITE_CODE:-$(sed -n 's/^Z_AGENT_INVITE_CODE=//p' .env 2>/dev/null | tail -1)}"
cat <<EOF

  Open the UI:  Ports tab -> 3000 -> Open in Browser
  Invite code:  ${INVITE:-<not set>}   (also in ~/.z-agent-invite)
  Logs:         tail -f ${LOG}
  Restart:      pkill -f 'server/index.mjs' ; bash .devcontainer/start.sh

  Running as a trusted single-user host (Z_AGENT_ALLOW_UNISOLATED_SHELL=1).
  Keep port ${PORT} on private visibility: this process executes code.
EOF
