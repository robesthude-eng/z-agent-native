FROM node:26.7.0-bookworm AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# npm prune re-resolves peer dependencies; preserve the lockfile's known-good
# dependency graph instead of failing on the optional React compiler peer range.
# Bundle with vite only. `tsc -b` is a CI gate; a type error must never be able
# to block a deploy that ships already-tested runtime code.
RUN npx --no vite build && npm prune --omit=dev --legacy-peer-deps

FROM node:26.7.0-bookworm-slim AS runtime
WORKDIR /app
# Keep a broad but bounded development substrate in the image. Agent sessions
# still run as unprivileged per-session UIDs; language packages and extra SDKs
# are provisioned below HOME by ensure_environment rather than with sudo/apt.
# Network recon tooling (netcat, ping, dig, psql) is deliberately absent: model
# generated code runs inside this image and must not find a ready made
# lateral-movement kit next to it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git openssh-client rsync curl ca-certificates unzip zip xz-utils util-linux file jq \
    python3 python3-venv python3-pip python3-dev \
    build-essential cmake ninja-build pkg-config libffi-dev libssl-dev \
    openjdk-17-jdk-headless \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
# The HTTP runtime stays root *inside this dedicated container* only so it can
# create a distinct unprivileged UID for every agent session. Tool shells and
# terminals are setuid before execution and cannot traverse /data or sibling
# workspaces. Do not add host Docker sockets or arbitrary host mounts here.
RUN mkdir -p /data /workspaces \
    && chmod 0700 /data \
    && chmod 0711 /workspaces
ENV PORT=3000 \
    Z_AGENT_DATA_DIR=/data \
    Z_AGENT_WORKSPACES_DIR=/workspaces \
    Z_AGENT_DIST_DIR=/app/dist
EXPOSE 3000
VOLUME ["/data", "/workspaces"]
CMD ["node", "server/index.mjs"]
