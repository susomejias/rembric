# syntax=docker/dockerfile:1.7

# Base: node:20-bookworm-slim. Alpine (musl) was attempted 2026-05-17 and
# rejected — sqlite-vec does NOT publish musl prebuilts on npm and would
# require building the extension from source per-arch. The ~80MB savings
# don't justify the Dockerfile complexity + breakage risk on sqlite-vec
# version bumps. Bookworm-slim glibc gets prebuilt artefacts cleanly for
# both better-sqlite3 and sqlite-vec.

FROM node:20-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build \
    && rm -rf node_modules \
    && pnpm install --frozen-lockfile --prod --ignore-scripts \
    && pnpm rebuild better-sqlite3 sqlite-vec


FROM node:20-bookworm-slim AS runtime

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

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["start"]


# Dev stage — used only by docker-compose.dev.yml via `target: dev`.
# Keeps all dev dependencies (tsx, vitest, etc.) so `tsx watch` can drive
# hot-reload against bind-mounted ./src. NOT pulled by canonical builds:
# `docker build .` and the publish workflow target the implicit final
# stage above (`runtime`), which is unchanged.
FROM node:20-bookworm-slim AS dev

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

RUN useradd -r -u 10001 -m rembric

WORKDIR /app

COPY --chown=rembric:rembric package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY --chown=rembric:rembric . .

# /app itself is created by WORKDIR as root-owned. The dev startup runs
# `pnpm run build:css` which mkdirs /app/dist/...; chown the whole tree
# so the non-root rembric user can write into it.
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
# Boot chain for the dev container:
#   1. build:css       — writes CSS bundles + manifest to dist/dashboard/public/
#                        (templates.ts looks there when running via tsx).
#   2. copy-assets     — mirrors src/dashboard/public (fonts, logo) → dist/.
#   3. seed-dev.ts --reset — ALWAYS wipes ./data-dev/ and reseeds with
#                        ~30 thematic rows + 3 fresh tokens (plaintext
#                        printed every boot). Predictable canvas: every
#                        `up` gives you the same starting state. Operator
#                        accumulated data does NOT survive an `up`; this
#                        is the dev stack's contract by design.
#   4. tsx watch       — exec'd so it owns PID 1 and handles SIGTERM properly.
#                        Reloads src/**/*.ts on host edits; CSS / seed
#                        require a container restart to re-run.
CMD ["sh", "-c", "pnpm run build:css && node scripts/copy-assets.mjs && tsx src/scripts/seed-dev.ts --reset && exec tsx watch src/cli.ts start"]
