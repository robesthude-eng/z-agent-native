#!/usr/bin/env bash
# z-agent-native provisioner.
#
# Brings a fresh Ubuntu 24.04 VM (Azure B2s, Hetzner CX22, any VPS) to a running
# hardened deployment: Docker, the z-agent stack, a TLS vhost and a firewall.
# Safe to re-run: every step checks state first.
#
# Usage:
#   sudo Z_AGENT_DOMAIN=agent.example.com bash azure/provision.sh
#   sudo bash azure/provision.sh                 # domain auto-derived from the public IP
#   DRY_RUN=1 bash azure/provision.sh            # print actions only
#
# Environment:
#   Z_AGENT_DOMAIN   public hostname for TLS. Empty => <public-ip>.sslip.io (no domain needed)
#   Z_AGENT_REPO     git remote (default: upstream of this repo)
#   Z_AGENT_DIR      install directory (default: /opt/z-agent-native)
#   Z_AGENT_PROFILE  hardened | trusted | unrestricted (default: trusted, single-user host)
#   Z_AGENT_SWAP_MB  swap to add on small hosts (default: 2048, 0 disables)
#   Z_AGENT_NETWORK_POLICY   off | allowlist | public. Overrides the profile default.
#                            On a host with a public IP use allowlist: the agent keeps
#                            search, webfetch and the browser, but only for the hosts
#                            you name instead of any public address.
#   Z_AGENT_NETWORK_ALLOWLIST  comma-separated hosts for allowlist mode, e.g.
#                            "api.open-meteo.com,html.duckduckgo.com,*.wikipedia.org"

set -euo pipefail

REPO="${Z_AGENT_REPO:-https://github.com/robesthude-eng/z-agent-native.git}"
DIR="${Z_AGENT_DIR:-/opt/z-agent-native}"
PROFILE="${Z_AGENT_PROFILE:-trusted}"
DOMAIN="${Z_AGENT_DOMAIN:-}"
SWAP_MB="${Z_AGENT_SWAP_MB:-2048}"
DRY_RUN="${DRY_RUN:-0}"
INFO_FILE="/root/z-agent-info.txt"

log()  { printf '\033[1;32m[z-agent]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[z-agent]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[z-agent]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
run()  { if [ "$DRY_RUN" = "1" ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
root() { if [ "$(id -u)" = "0" ]; then "$@"; else run sudo "$@"; fi; }

# ---------------------------------------------------------------- 0. sanity
[ "$(uname -s)" = "Linux" ] || die "this provisioner targets Linux"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || warn "expected Ubuntu, found ${ID:-unknown} — continuing"
fi
if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" != "0" ] && ! have sudo; then
  die "run as root, or install sudo"
fi

TOTAL_MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
log "host: ${TOTAL_MEM_MB} MB RAM, $(nproc) vCPU"
if [ "$TOTAL_MEM_MB" -lt 3500 ]; then
  warn "the compose profile caps memory at ~3.2 GB; ${TOTAL_MEM_MB} MB is below the recommended 4 GB"
fi

# ------------------------------------------------------------ 1. base packages
log "installing base packages"
root apt-get update -qq
root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl git gnupg ufw unattended-upgrades

# keep security updates on; this is an Internet-facing host
root systemctl enable --now unattended-upgrades || warn "unattended-upgrades not enabled"

# ---------------------------------------------------------------- 2. swapfile
# Docker builds (node + Chromium images) are the memory peak on a 4 GB box.
if [ "$SWAP_MB" -gt 0 ] && [ "$TOTAL_MEM_MB" -lt 8192 ] && have swapon && ! swapon --show | grep -q .; then
  log "adding ${SWAP_MB} MB swap"
  root fallocate -l "${SWAP_MB}M" /swapfile
  root chmod 600 /swapfile
  root mkswap /swapfile
  root swapon /swapfile
  if ! grep -q '^/swapfile' /etc/fstab; then
    root bash -c 'echo "/swapfile none swap sw 0 0" >> /etc/fstab'
  fi
fi

# -------------------------------------------------------------------- 3. docker
if have docker && docker compose version >/dev/null 2>&1; then
  log "docker already installed: $(docker --version)"
else
  log "installing Docker Engine + Compose v2"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] curl -fsSL https://get.docker.com | sh"
  else
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    root sh /tmp/get-docker.sh
  fi
  root systemctl enable --now docker
fi

# --------------------------------------------------------------------- 4. repo
if [ -d "$DIR/.git" ]; then
  log "updating existing checkout in $DIR"
  run git -C "$DIR" fetch --depth 1 origin
else
  log "cloning $REPO into $DIR"
  root mkdir -p "$DIR"
  root git clone --depth 1 "$REPO" "$DIR"
fi

# ------------------------------------------------------- 5. secrets and domain
cd "$DIR"
if [ -f .env ]; then
  log ".env already exists — keeping the existing keys"
else
  log "generating .env (profile: $PROFILE) with fresh 256-bit keys"
  if have node && [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge 24 ]; then
    run node scripts/init-production-env.mjs --profile="$PROFILE"
  else
    # no Node on the host: run the very same generator inside the official image
    root docker run --rm -v "$DIR:/w" -w /w node:24-alpine \
      node scripts/init-production-env.mjs --profile="$PROFILE"
  fi
  # the generator writes .env as root with mode 0600
  if [ "$DRY_RUN" != "1" ]; then
    root chmod 600 .env
  fi
fi

if [ -z "$DOMAIN" ] && [ "$DRY_RUN" != "1" ]; then
  PUBLIC_IP=$(curl -fsS --max-time 10 https://api.ipify.org || true)
  if [ -n "${PUBLIC_IP:-}" ]; then
    DOMAIN="${PUBLIC_IP}.sslip.io"
    warn "no Z_AGENT_DOMAIN given; using ${DOMAIN} (wildcard DNS, no domain purchase needed)"
  fi
fi

if [ -n "$DOMAIN" ]; then
  log "setting Z_AGENT_DOMAIN=$DOMAIN"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] set Z_AGENT_DOMAIN=$DOMAIN in $DIR/.env"
  else
    root sed -i "s|^Z_AGENT_DOMAIN=.*|Z_AGENT_DOMAIN=${DOMAIN}|" .env
  fi
else
  warn "no public hostname available; keeping Z_AGENT_DOMAIN=localhost (secure cookies will be off)"
fi

# ------------------------------------------------- 5b. agent network policy
if [ -n "${Z_AGENT_NETWORK_POLICY:-}" ]; then
  case "$Z_AGENT_NETWORK_POLICY" in
    off|allowlist|public) ;;
    *) warn "unknown Z_AGENT_NETWORK_POLICY=${Z_AGENT_NETWORK_POLICY}; keeping the profile default"; Z_AGENT_NETWORK_POLICY="" ;;
  esac
fi

if [ -n "${Z_AGENT_NETWORK_POLICY:-}" ]; then
  log "agent network policy: ${Z_AGENT_NETWORK_POLICY}"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] set Z_AGENT_NETWORK_POLICY=${Z_AGENT_NETWORK_POLICY} in $DIR/.env"
  else
    root sed -i "s|^Z_AGENT_NETWORK_POLICY=.*|Z_AGENT_NETWORK_POLICY=${Z_AGENT_NETWORK_POLICY}|" .env
    # The second opt-in only exists for public egress: keep it honest either way.
    if [ "$Z_AGENT_NETWORK_POLICY" = "public" ]; then
      root sed -i "s|^Z_AGENT_ALLOW_PUBLIC_WEB=.*|Z_AGENT_ALLOW_PUBLIC_WEB=1|" .env
    else
      root sed -i "s|^Z_AGENT_ALLOW_PUBLIC_WEB=.*|Z_AGENT_ALLOW_PUBLIC_WEB=0|" .env
    fi
  fi
fi

if [ -n "${Z_AGENT_NETWORK_ALLOWLIST:-}" ]; then
  log "agent network allowlist: ${Z_AGENT_NETWORK_ALLOWLIST}"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] set Z_AGENT_NETWORK_ALLOWLIST in $DIR/.env"
  else
    root sed -i "s|^Z_AGENT_NETWORK_ALLOWLIST=.*|Z_AGENT_NETWORK_ALLOWLIST=${Z_AGENT_NETWORK_ALLOWLIST}|" .env
  fi
fi

if [ "${Z_AGENT_NETWORK_POLICY:-}" = "allowlist" ] && [ -z "${Z_AGENT_NETWORK_ALLOWLIST:-}" ]; then
  warn "allowlist mode without Z_AGENT_NETWORK_ALLOWLIST: the agent will refuse every host"
fi

# ----------------------------------------------------------------- 6. firewall
log "configuring ufw (22, 80, 443)"
root ufw allow OpenSSH
root ufw allow 80/tcp
root ufw allow 443/tcp
root ufw --force enable

# ------------------------------------------------------------------ 7. compose
log "building and starting the stack (first build takes several minutes)"
root docker compose up --build -d

# -------------------------------------------------------- 8. health + summary
INVITE=""
if [ "$DRY_RUN" != "1" ] && [ -f .env ]; then
  INVITE=$(sed -n 's/^Z_AGENT_INVITE_CODE=//p' .env | head -1)
fi

if [ "$DRY_RUN" != "1" ]; then
  log "waiting for the runtime to answer /health ..."
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 http://127.0.0.1:3002/health >/tmp/health.json 2>/dev/null; then
      log "health: $(cat /tmp/health.json | head -c 200)"
      break
    fi
    sleep 2
  done
  log "waiting for the TLS certificate (Let's Encrypt, up to ~2 min) ..."
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 "https://${DOMAIN}/health" >/dev/null 2>&1; then
      log "TLS OK: https://${DOMAIN}"
      break
    fi
    sleep 2
  done
fi

INFO=$(cat <<EOF
z-agent-native deployment
=========================
URL:            https://${DOMAIN:-localhost}
Invite code:    ${INVITE:-<read Z_AGENT_INVITE_CODE from $DIR/.env>}
Install dir:    $DIR
Compose profile: $PROFILE
Status:         docker compose -f $DIR/docker-compose.yml ps
Logs:           docker compose -f $DIR/docker-compose.yml logs -f z-agent
Health:         http://127.0.0.1:3002/health
Backup:         npm run db:backup -- /root/z-agent-\$(date +%F).sqlite

First steps
-----------
1. Open https://${DOMAIN:-localhost}
2. Register with the invite code above — the first account becomes administrator.
3. Settings -> Providers: add a model provider key (Gemini/Groq/OpenRouter are free, no card).
4. Keep Z_AGENT_ALLOW_UNISOLATED_SHELL=0 on this host: the Docker executor is the isolation boundary.
EOF
)

if [ "$DRY_RUN" = "1" ]; then
  printf '\n--- would write %s ---\n%s\n' "$INFO_FILE" "$INFO"
else
  printf '%s\n' "$INFO" | root tee "$INFO_FILE" >/dev/null
  root chmod 600 "$INFO_FILE"
  printf '\n%s\n' "$INFO"
fi

log "done"
