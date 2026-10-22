# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install everything and produce the frontend bundle.
# Kept separate so the runtime image never contains a compiler toolchain or the
# Vite/React toolchain.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Build tools for better-sqlite3 if no prebuilt binary matches this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first, so source edits do not invalidate this layer.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY web ./web
COPY shared ./shared
RUN npm run build:web

# Drop dev dependencies, keeping only what the server needs at runtime.
RUN npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini gives us correct PID 1 signal handling (so SIGTERM actually stops us).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=7788 \
    # Inside a container we must listen on all interfaces for the port mapping
    # to work. DOCKER-COMPOSE PUBLISHES THIS ON 127.0.0.1 ONLY BY DEFAULT —
    # do not change that unless you put an authenticated proxy in front.
    HOST=0.0.0.0 \
    SENTINEL_DB_PATH=/data/sentinel.db

# Runtime is intentionally unprivileged; Docker Compose additionally drops
# Linux capabilities and mounts the image filesystem read-only.

WORKDIR /app

# Split ownership: code is read-only to the runtime user, /data is writable.
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/web/dist ./web/dist
COPY --chown=root:root package.json ./
COPY --chown=root:root server ./server
COPY --chown=root:root shared ./shared
COPY --chown=root:root scripts ./scripts

# Normalise permissions explicitly. COPY preserves the build-context file modes,
# and a developer's machine may hold source files as 0600 (which the unprivileged
# "node" user then cannot read). Code must be world-readable, never writable.
RUN find /app -type d -exec chmod 755 {} + \
 && find /app -type f -exec chmod 644 {} + \
 && mkdir -p /data \
 && chown -R node:node /data

USER node

VOLUME ["/data"]
EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
