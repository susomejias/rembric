# syntax=docker/dockerfile:1.7

# Stage order is load-bearing: `runtime` MUST be last so `docker build .`
# without `--target` builds the prod image by default. See
# openspec/specs/development-environment/spec.md.

FROM node:22-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# --ignore-scripts is redundant given .npmrc, kept as defense in depth.
# The explicit `pnpm rebuild` below runs the postinstall for the
# allowlisted native modules (better-sqlite3, sqlite-vec) under the controlled
# allowlist in pnpm-workspace.yaml.
RUN pnpm run build \
    && rm -rf node_modules \
    && pnpm install --frozen-lockfile --prod --ignore-scripts \
    && pnpm rebuild better-sqlite3 sqlite-vec


FROM node:22-bookworm-slim AS dev

LABEL rembric.stage=dev

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

RUN useradd -r -u 10001 -m rembric

WORKDIR /app

COPY --chown=rembric:rembric package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY --chown=rembric:rembric . .

RUN mkdir -p /app/dist && chown -R rembric:rembric /app

USER rembric

ENV PATH="/app/node_modules/.bin:${PATH}" \
    REMBRIC_DATA_DIR=/data \
    REMBRIC_HOST=0.0.0.0 \
    REMBRIC_PORT=8787

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --retries=5 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{Authorization:'Bearer '+process.env.REMBRIC_ADMIN_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT []
CMD ["sh", "-c", "pnpm run build:css && node scripts/copy-assets.mjs && tsx src/scripts/seed-dev.ts --reset && exec tsx watch src/server-entrypoint.ts"]


FROM node:22-bookworm-slim AS runtime

LABEL rembric.stage=runtime

RUN useradd -r -u 10001 -m rembric

WORKDIR /app

COPY --from=builder --chown=rembric:rembric /app/dist           ./dist
COPY --from=builder --chown=rembric:rembric /app/node_modules   ./node_modules
COPY --from=builder --chown=rembric:rembric /app/package.json   ./

USER rembric

ENV REMBRIC_DATA_DIR=/data \
    REMBRIC_HOST=0.0.0.0 \
    REMBRIC_PORT=8787

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{Authorization:'Bearer '+process.env.REMBRIC_ADMIN_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/server-entrypoint.js"]
