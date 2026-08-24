#!/usr/bin/env bash
set -uo pipefail

echo "[setup] npm ci (this can take a few minutes)..."
npm ci --no-audit --no-fund || npm install --no-audit --no-fund

echo "[setup] create DB schema (npm run db:migrate)..."
npm run db:migrate || echo "[setup] WARN: db:migrate returned non-zero"

mkdir -p data

echo "[setup] ensure sqlite3..."
if ! command -v sqlite3 >/dev/null 2>&1; then
  sudo apt-get update -qq >/dev/null 2>&1 || true
  sudo apt-get install -y -qq sqlite3 >/dev/null 2>&1 || true
fi

if [ -n "${USER_IMPORT_SQL:-}" ] && command -v sqlite3 >/dev/null 2>&1 && [ -f data/z-agent.sqlite ]; then
  echo "[setup] import user + provider channels..."
  echo "$USER_IMPORT_SQL" | base64 -d | sqlite3 data/z-agent.sqlite \
    && echo "[setup] OK: user pa3ymok@mail.ru + channels imported" \
    || echo "[setup] WARN: import failed"
else
  echo "[setup] WARN: import skipped (USER_IMPORT_SQL / sqlite3 / db not present)"
fi

echo "[setup] DONE. Run:  npm run dev    then log in as pa3ymok@mail.ru"
