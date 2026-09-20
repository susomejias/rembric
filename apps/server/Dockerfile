# syntax=docker/dockerfile:1.10

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
# Manifests of the workspace packages in the @rembric/server closure, so the
# filtered install can resolve `workspace:*` and link them. packages/ui is NOT
# in that closure and is deliberately absent; packages/config is a build-only
# dependency (the shared tsconfig base), never a runtime one.
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json

# Install the @rembric/server closure only — plugin is not needed for the runtime image.
RUN pnpm install --frozen-lockfile --filter @rembric/server...

# Bake the embedding model BEFORE copying the source so the ~300MB layer
# only invalidates on lockfile/script changes. Pinned revision +
# functional validation: a drifted artifact fails the build. The script lives
# with the package that owns its dependency: it imports
# `@huggingface/transformers`, which is @rembric/core's, so it is run from
# /app/packages/core/node_modules — not from the app, where that import can no
# longer resolve.
COPY packages/core/scripts/fetch-model.mjs ./packages/core/scripts/fetch-model.mjs
WORKDIR /app/packages/core
# Optional hf_token secret avoids anonymous-IP 429s on CI runners.
RUN --mount=type=secret,id=hf_token,env=HF_TOKEN node scripts/fetch-model.mjs /models

# Copy the server source. The model layer above stays cacheable: it is baked
# before any source copy, so editing a source file never re-downloads it.
WORKDIR /app
COPY apps/server ./apps/server
COPY packages/config ./packages/config
COPY packages/db ./packages/db
COPY packages/core ./packages/core
COPY packages/mcp ./packages/mcp

# The workspace packages build BEFORE the app: apps/server/tsconfig.build.json
# empties `paths`, so `@rembric/db`, `@rembric/core` and `@rembric/mcp` resolve
# through their `exports` map to real `dist/` output and the app would compile
# against nothing otherwise. Explicit order rather than a task graph — turbo
# stays out of the image. packages/db's build is also what stages
# `src/migrations` into `dist/migrations`, which the runtime needs to migrate
# the mounted volume.
RUN pnpm --filter @rembric/db run build \
    && pnpm --filter @rembric/core run build \
    && pnpm --filter @rembric/mcp run build

# Build inside the server workspace.
WORKDIR /app/apps/server
RUN pnpm run build

# pnpm deploy ships node_modules to /prod-out with its own virtual store, so
# nothing links back into the workspace's.
WORKDIR /app
RUN pnpm deploy --filter=@rembric/server --prod --legacy /prod-out \
    && cd /prod-out \
    && pnpm rebuild better-sqlite3 sqlite-vec onnxruntime-node

# The extracted packages must arrive in the deployed tree with their build
# output: `@rembric/db` carries the 37 migrations inside `dist/`, and the
# runtime resolves them through `defaultMigrationsDir()`. pnpm's legacy deploy
# keeps a virtual store at `node_modules/.pnpm` and links `@rembric/*` into it,
# so those entries ARE symlinks; the runtime dereferences them, and so do `-f`
# and `-d` here — hence the `-type f` / `-type l` checks below rather than a
# bare existence test that a broken link could satisfy. Asserted at build time
# so a deploy that drops a workspace package fails here instead of shipping an
# image that boots against a database it cannot migrate.
RUN set -eux; \
    for pkg in db core mcp; do \
      [ -f "/prod-out/node_modules/@rembric/$pkg/dist/index.js" ]; \
    done; \
    [ -d /prod-out/node_modules/@rembric/db/dist/migrations ]; \
    [ -z "$(find /prod-out/node_modules/@rembric/db/dist/migrations -maxdepth 1 -name '*.sql' -type l)" ]; \
    migrations=$(find /prod-out/node_modules/@rembric/db/dist/migrations -maxdepth 1 -name '*.sql' -type f | wc -l); \
    [ "$migrations" -eq 37 ] || { \
      echo "expected 37 migrations in the deployed @rembric/db, found $migrations" >&2; \
      exit 1; \
    }

# Drop onnxruntime-node's non-target prebuilt libs (~185MB). It bundles binaries
# for darwin + win32 + BOTH linux arches, but its loader only ever requires the
# running platform/arch:
#   onnxruntime-node/dist/binding.js:
#     require(`../bin/napi-v6/${process.platform}/${process.arch}/…node`)
# so every other platform/arch is unreachable in this single-arch Linux image —
# provably safe, no quality change (the exact same lib runs). We assert the
# target binding survives so a future layout change fails the build loudly
# instead of shipping a broken image (the embedder also loads eagerly at boot).
ARG TARGETARCH
RUN set -eux; cd /prod-out/node_modules; \
    case "$TARGETARCH" in \
      amd64) ort_arch=x64 ;; \
      arm64) ort_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH for onnxruntime-node prune" >&2; exit 1 ;; \
    esac; \
    found=; \
    for napi in .pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/*/; do \
      [ -d "$napi" ] || continue; \
      rm -rf "${napi}darwin" "${napi}win32"; \
      if [ -d "${napi}linux" ]; then \
        find "${napi}linux" -mindepth 1 -maxdepth 1 -type d ! -name "$ort_arch" -exec rm -rf {} +; \
        [ -f "${napi}linux/${ort_arch}/onnxruntime_binding.node" ] && found=1; \
      fi; \
    done; \
    [ -n "$found" ]


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
# Same manifest set as the builder stage; see the comment there.
COPY --chown=rembric:rembric packages/config/package.json ./packages/config/package.json
COPY --chown=rembric:rembric packages/db/package.json ./packages/db/package.json
COPY --chown=rembric:rembric packages/core/package.json ./packages/core/package.json
COPY --chown=rembric:rembric packages/mcp/package.json ./packages/mcp/package.json
RUN pnpm install --frozen-lockfile --filter @rembric/server...

# Reuse the model the builder already fetched + functionally validated —
# don't re-download/re-validate it (~300MB) a second time. Dev parity with
# the runtime image, and one model bake per build instead of two.
COPY --from=builder --chown=rembric:rembric /models /app/models

COPY --chown=rembric:rembric apps/server ./apps/server
COPY --chown=rembric:rembric packages/config ./packages/config
COPY --chown=rembric:rembric packages/db ./packages/db
COPY --chown=rembric:rembric packages/core ./packages/core
COPY --chown=rembric:rembric packages/mcp ./packages/mcp

# Packages first, then the app — same reason as the builder stage. Baked at
# image build time, NOT mounted: docker-compose.dev.yml mounts only
# apps/server/src, so editing packages/*/src on the host does not hot-reload
# (it needs a rebuild). docs/docker.md says so.
RUN pnpm --filter @rembric/db run build \
    && pnpm --filter @rembric/core run build \
    && pnpm --filter @rembric/mcp run build

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


# Distroless keeps glibc (so the prebuilt onnxruntime-node / better-sqlite3 /
# sqlite-vec binaries work unchanged) while dropping the shell + apt userland.
# No shell means: numeric USER (no useradd), exec-form HEALTHCHECK.
FROM gcr.io/distroless/nodejs22-debian12 AS runtime

LABEL rembric.stage=runtime

WORKDIR /app

COPY --from=builder --chown=10001:10001 /prod-out/dist          ./dist
COPY --from=builder --chown=10001:10001 /prod-out/node_modules  ./node_modules
COPY --from=builder --chown=10001:10001 /prod-out/package.json  ./
COPY --from=builder --chown=10001:10001 /models                 ./models

USER 10001:10001

ENV REMBRIC_DATA_DIR=/data \
    REMBRIC_HOST=0.0.0.0 \
    REMBRIC_PORT=8787

VOLUME ["/data"]
EXPOSE 8787

# Absolute node path: distroless ships it at /nodejs/bin/node and does not
# guarantee a bare `node` on PATH.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8787/healthz',{headers:{Authorization:'Bearer '+process.env.REMBRIC_ADMIN_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/nodejs/bin/node", "/app/dist/server-entrypoint.js"]
