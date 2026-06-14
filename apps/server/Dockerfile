# syntax=docker/dockerfile:1.10

# Stage order is load-bearing: `runtime` MUST be last so `docker build .`
# without `--target` builds the prod image by default. See
# openspec/specs/development-environment/spec.md.
#
# Build context is the repo root (the monorepo's pnpm workspace).
# docker-compose specifies context: . and dockerfile: apps/server/Dockerfile.

FROM node:26-bookworm-slim AS builder

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

# Bake the embedding model BEFORE copying the source so the ~300MB layer
# only invalidates on lockfile/script changes. Pinned revision +
# functional validation: a drifted artifact fails the build.
COPY apps/server/scripts/fetch-model.mjs ./apps/server/scripts/fetch-model.mjs
WORKDIR /app/apps/server
# Optional hf_token secret avoids anonymous-IP 429s on CI runners.
RUN --mount=type=secret,id=hf_token,env=HF_TOKEN node scripts/fetch-model.mjs /models

# Copy the server source.
WORKDIR /app
COPY apps/server ./apps/server

# Build inside the server workspace.
WORKDIR /app/apps/server
RUN pnpm run build

# pnpm deploy ships a flat node_modules to /prod-out (no symlinks into the workspace store).
WORKDIR /app
RUN pnpm deploy --filter=@rembric/server --prod --legacy /prod-out \
    && cd /prod-out \
    && pnpm rebuild better-sqlite3 sqlite-vec onnxruntime-node

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


FROM node:26-bookworm-slim AS dev

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

# Reuse the model the builder already fetched + functionally validated —
# don't re-download/re-validate it (~300MB) a second time. Dev parity with
# the runtime image, and one model bake per build instead of two.
COPY --from=builder --chown=rembric:rembric /models /app/models

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
