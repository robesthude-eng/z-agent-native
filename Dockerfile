FROM node:24-bookworm AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git openssh-client rsync curl ca-certificates unzip zip util-linux \
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
