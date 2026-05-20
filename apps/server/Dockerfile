# syntax=docker/dockerfile:1.7

# Stage order is load-bearing: `runtime` MUST be last so `docker build .`
# without `--target` builds the prod image by default. See
# openspec/specs/development-environment/spec.md.
#
# Build context is the repo root (the monorepo's pnpm workspace).
# docker-compose specifies context: . and dockerfile: apps/server/Dockerfile.

FROM node:22-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app

# Copy workspace manifest + lockfile first for cache-friendly installs.
COPY package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/plugin/package.json ./apps/plugin/package.json

# Install the @rembric/server closure only — plugin is not needed for the runtime image.
RUN pnpm install --frozen-lockfile --filter @rembric/server...

# Copy the server source.
COPY apps/server ./apps/server

# Build inside the server workspace.
WORKDIR /app/apps/server

# --ignore-scripts is redundant given .npmrc, kept as defense in depth.
# The explicit `pnpm rebuild` below runs the postinstall for the
# allowlisted native modules (better-sqlite3, sqlite-vec) under the controlled
# allowlist in pnpm-workspace.yaml.
RUN pnpm run build

WORKDIR /app

RUN rm -rf node_modules apps/server/node_modules \
    && pnpm install --frozen-lockfile --prod --ignore-scripts --filter @rembric/server... \
    && pnpm rebuild --filter @rembric/server better-sqlite3 sqlite-vec


FROM node:22-bookworm-slim AS dev

LABEL rembric.stage=dev

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

RUN useradd -r -u 10001 -m rembric

WORKDIR /app

COPY --chown=rembric:rembric package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
COPY --chown=rembric:rembric apps/server/package.json ./apps/server/package.json
COPY --chown=rembric:rembric apps/plugin/package.json ./apps/plugin/package.json
RUN pnpm install --frozen-lockfile --filter @rembric/server...

COPY --chown=rembric:rembric apps/server ./apps/server

RUN mkdir -p /app/apps/server/dist && chown -R rembric:rembric /app

USER rembric

ENV PATH="/app/node_modules/.bin:/app/apps/server/node_modules/.bin:${PATH}" \
    REMBRIC_DATA_DIR=/data \
    REMBRIC_HOST=0.0.0.0 \
    REMBRIC_PORT=8787

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --retries=5 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{Authorization:'Bearer '+process.env.REMBRIC_ADMIN_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/server

ENTRYPOINT []
CMD ["sh", "-c", "pnpm run build:css && node scripts/copy-assets.mjs && tsx src/scripts/seed-dev.ts --reset && exec tsx watch src/server-entrypoint.ts"]


FROM node:22-bookworm-slim AS runtime

LABEL rembric.stage=runtime

RUN useradd -r -u 10001 -m rembric

WORKDIR /app

COPY --from=builder --chown=rembric:rembric /app/apps/server/dist          ./dist
COPY --from=builder --chown=rembric:rembric /app/apps/server/node_modules  ./node_modules
COPY --from=builder --chown=rembric:rembric /app/apps/server/package.json  ./

USER rembric

ENV REMBRIC_DATA_DIR=/data \
    REMBRIC_HOST=0.0.0.0 \
    REMBRIC_PORT=8787

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{Authorization:'Bearer '+process.env.REMBRIC_ADMIN_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/server-entrypoint.js"]
