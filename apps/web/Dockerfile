# syntax=docker/dockerfile:1.10

# The Next.js app's production image (`@rembric/web`) — the image the release
# channel publishes.
#
# Stage order is load-bearing: `runner` MUST be last so `docker build .` without
# `--target` builds the prod image by default; see
# openspec/specs/development-environment/spec.md.
#
# Build context is the repo root (the monorepo's pnpm workspace):
#   docker build -f apps/web/Dockerfile -t rembric-web .
#
# Why the install is a filtered install over the root context rather than
# `turbo prune web --docker`: turbo is a root devDependency, so pruning inside
# the image needs the workspace installed *before* the prune can run — a second
# install, of the whole workspace, ahead of the one that matters. A plain
# filtered install from the manifests copied below resolves the exact
# `@rembric/web` closure out of the locked graph in one step.
#
# Data-safety contract (DS3, see odd/tasks/migrate-to-nextjs.md): the runtime
# keeps `REMBRIC_DATA_DIR=/data` and `VOLUME ["/data"]` so an existing
# operator's database stays reachable. `createDb` creates a *fresh, empty*
# `data.db` in silence when that resolution drifts, so the directory is
# pre-created here owned by the runtime user — a named volume is initialised
# from the image, which is what lets uid 10001 open the file at all.

FROM node:22-bookworm-slim AS base

# build-essential + python3 are the native-module toolchain: better-sqlite3
# builds from source when no prebuilt matches the platform/ABI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app


FROM base AS builder

# Copy workspace manifest + lockfile first for cache-friendly installs.
COPY package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/plugin/package.json ./apps/plugin/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json

# `node-linker=hoisted` is load-bearing, and is a Docker-only choice (set on the
# command line, so the repository's own layout is untouched). Two measured
# reasons, both fatal without it:
#
#   1. Next externalises `serverExternalPackages` (better-sqlite3, sqlite-vec,
#      onnxruntime-node) as a bare `require(...)` inside the server *chunks*,
#      so the runtime resolves them from the chunk's own directory. pnpm's
#      default symlinked layout only guarantees resolution from inside the
#      dependent package, which a chunk is not.
#   2. `@vercel/nft` emits what it resolves *by real path*. Under that layout
#      every dependency's real path is `node_modules/.pnpm/...`, so the traced
#      tree gets `.pnpm/**` plus top-level directories holding nothing but a
#      `package.json` — measured, from a clean root: `require.resolve('next')`
#      answered, and `better-sqlite3`/`sqlite-vec`/`onnxruntime-node` failed
#      with `MODULE_NOT_FOUND` / "Cannot find module
#      'node_modules/better-sqlite3/lib/index.js'". A flat, npm-style tree puts
#      every traced dependency at the top level, where Node actually looks.
RUN pnpm install --frozen-lockfile --filter @rembric/web... --config.node-linker=hoisted

# Bake the embedding model BEFORE copying the source so the ~341MB layer only
# invalidates on lockfile/script changes. Pinned revision + functional
# validation: a drifted artifact fails the build. The script imports
# `@huggingface/transformers`, which is @rembric/core's dependency, so it runs
# from /app/packages/core/node_modules — not from the app, where that import
# cannot resolve.
COPY packages/core/scripts/fetch-model.mjs ./packages/core/scripts/fetch-model.mjs
# The bake imports the shared model identity, which lives with the package source
# (not copied yet at this layer): ship just that file so the two cannot drift.
COPY packages/core/src/embeddings/model-identity.json ./packages/core/src/embeddings/model-identity.json
WORKDIR /app/packages/core
# Optional hf_token secret avoids anonymous-IP 429s on CI runners.
RUN --mount=type=secret,id=hf_token,env=HF_TOKEN node scripts/fetch-model.mjs /models

# The standalone server chdirs into its own directory, but next.config.ts's
# tracing includes are resolved against the app directory, so the layout under
# /app must match the repository's. Copy the source the same way.
WORKDIR /app
COPY apps/web ./apps/web
COPY packages/config ./packages/config
COPY packages/db ./packages/db
COPY packages/core ./packages/core
COPY packages/mcp ./packages/mcp

# The workspace packages build BEFORE the app. `apps/web` type-imports
# `@rembric/db`/`@rembric/core`/`@rembric/mcp` through their `exports` map to
# real `dist/` output, and Next's build-time type check compiles against it —
# without it the app build fails on missing declarations. packages/db's build
# is also what stages `src/migrations` into `dist/migrations`, which
# outputFileTracingIncludes then copies into the standalone tree.
RUN pnpm --filter @rembric/db run build \
    && pnpm --filter @rembric/core run build \
    && pnpm --filter @rembric/mcp run build

# `next build` with `output: 'standalone'` (next.config.ts). The traced output
# lands in apps/web/.next/standalone mirroring the repository layout, because
# `outputFileTracingRoot` is the monorepo root.
WORKDIR /app/apps/web
RUN pnpm run build

# Assembled runtime tree. It is NOT the `.next/standalone` directory copied
# verbatim: that tree's node_modules is the traced one described above, and its
# top-level package directories are `package.json`-only stubs. The app code and
# the traced non-JS assets come from there; node_modules comes from the flat
# install, which is the only layout that resolves for the chunks — and, being
# the installed tree itself, it carries the native postinstall outputs
# (better-sqlite3's `.node`, onnxruntime-node's platform binding) without any
# `pnpm rebuild` step.
#
# It is the full closure, devDependencies included. Trimming them needs either
# `pnpm install --prod`, which fails here on the root `prepare` script (husky is
# a devDependency, so `--prod` removes it before running it), or `pnpm deploy
# --prod`, which would need the `pnpm rebuild` the supply-chain inventory polices
# in this file. A production runtime tree without the
# build toolchain is worth a follow-up; it is not worth an unguarded rebuild.
#
#   apps/web/next-server.js + .next/**
#                                   — the standalone server and its chunks. The
#                                     generated `server.js` is renamed here so
#                                     the launcher (copied into the runner at
#                                     `apps/web/server.js`) is what the entrypoint
#                                     runs; the generated file keeps its own
#                                     directory, so its `process.chdir(__dirname)`
#                                     and `require('next')` root are unchanged.
#   packages/db/dist/migrations     — outputFileTracingIncludes put them here,
#                                     and `defaultMigrationsDir()` (dirname of
#                                     the bundle's import.meta.url) reads them
#                                     back from this exact root-relative path
#   node_modules                    — the flat closure, which also carries
#                                     `sqlite-vec-linux-<arch>`: that is the
#                                     optional dependency next.config.ts's other
#                                     tracing include was written to place for a
#                                     `.pnpm` layout, so with a flat tree the
#                                     glob matches nothing and the package
#                                     arrives as an ordinary installed one
#   dist/                           — the cross-version upgrader files the gate below asserts
RUN set -eux; \
    rm -rf /runtime; mkdir -p /runtime; \
    cp -a /app/apps/web/.next/standalone/apps /runtime/apps; \
    cp -a /app/apps/web/.next/standalone/packages /runtime/packages; \
    mv /runtime/apps/web/server.js /runtime/apps/web/next-server.js; \
    rm -rf /runtime/apps/web/node_modules; \
    cp -a /app/node_modules /runtime/node_modules; \
    mkdir -p /runtime/dist/scripts /runtime/dist/services/self-update; \
    cp /app/packages/core/dist/scripts/upgrade-helper.js /runtime/dist/scripts/upgrade-helper.js; \
    cp /app/packages/core/dist/services/self-update/engine-api.js /runtime/dist/services/self-update/engine-api.js; \
    printf '{"type":"module"}\n' > /runtime/dist/package.json

# onnxruntime-node's non-target prebuilt libs (~185MB) are pruned: its loader
# only ever requires the running platform/arch, so every other pair is
# unreachable in this single-arch Linux image. The target binding is asserted so
# a layout change fails the build loudly instead of shipping an embedder that
# cannot load.
ARG TARGETARCH
RUN set -eux; cd /runtime/node_modules/onnxruntime-node; \
    case "$TARGETARCH" in \
      amd64) ort_arch=x64 ;; \
      arm64) ort_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH for onnxruntime-node prune" >&2; exit 1 ;; \
    esac; \
    for napi in bin/*/; do \
      rm -rf "${napi}darwin" "${napi}win32"; \
      if [ -d "${napi}linux" ]; then \
        find "${napi}linux" -mindepth 1 -maxdepth 1 -type d ! -name "$ort_arch" -exec rm -rf {} +; \
      fi; \
    done; \
    [ -f "bin/napi-v6/linux/${ort_arch}/onnxruntime_binding.node" ]

# Build-time gates, run against the assembled runtime tree itself — `/runtime`
# has no ancestor `node_modules`, so what is resolved here is what the runner
# resolves. (The first version of this file checked the traced tree from inside
# `/app/apps/web/.next/standalone`, where Node walks up into the builder's own
# `/app/node_modules`; every check passed and the image could not start.)
#
# Each gate protects a failure that is otherwise silent at runtime: a missing
# `next-server.js` (the renamed generated server) or launcher is an image that
# cannot start; a missing migrations directory
# throws when the migration runner reads the mounted volume (37 is the full
# set — the count is the gate); a native module that does not resolve throws at
# boot, after the process looks healthy enough to accept traffic; a missing
# baked model turns the embedder into a runtime download. The native modules
# are not merely resolved but loaded, which is what the runtime does — the
# embedder loads eagerly in the server image, and `sqlite-vec.load()` here is
# the same call `createDb` makes. The release-identity gate checks the exact
# `/app/apps/web/package.json` the runner stage copies in: a bootstrap `0.0.0`
# reaching the image would make the brand report a version that is not running
# — the failure this reanchor exists to prevent — so the build fails loudly
# rather than shipping the sentinel. (`lib/version.ts` finds that file by
# walking up from `/app/apps/web`.)
RUN set -eux; \
    [ -f /runtime/apps/web/next-server.js ]; \
    [ -f /app/apps/web/server.js ]; \
    release_version=$(node -p "require('/app/apps/web/package.json').version"); \
    printf '%s' "$release_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || { \
      echo "release identity is not a semver: '$release_version'" >&2; \
      exit 1; \
    }; \
    [ "$release_version" != '0.0.0' ] || { \
      echo "release identity is the unset bootstrap version 0.0.0" >&2; \
      exit 1; \
    }; \
    [ -d /runtime/packages/db/dist/migrations ]; \
    migrations=$(find /runtime/packages/db/dist/migrations -maxdepth 1 -name '*.sql' -type f | wc -l); \
    [ "$migrations" -eq 37 ] || { \
      echo "expected 37 migrations in the runtime tree, found $migrations" >&2; \
      find /runtime -name '*.sql' | head -50 >&2; \
      exit 1; \
    }; \
    [ -f /runtime/dist/scripts/upgrade-helper.js ]; \
    [ -f /runtime/dist/services/self-update/engine-api.js ]; \
    [ -f /runtime/dist/package.json ]; \
    [ -f /models/onnx-community/gte-multilingual-base/onnx/model_quantized.onnx ]; \
    cd /runtime/apps/web; \
    node -e 'let bad=0; \
      for (const m of ["next","better-sqlite3","sqlite-vec","onnxruntime-node"]) { \
        try { console.log("[gate] resolve", m, "->", require.resolve(m)); } \
        catch (e) { bad=1; console.log("[gate] UNRESOLVABLE", m, e.code); } \
      } \
      try { const Database=require("better-sqlite3"); new Database(":memory:").close(); console.log("[gate] better-sqlite3 loads"); } \
      catch (e) { bad=1; console.log("[gate] better-sqlite3 DOES NOT LOAD:", String(e.message).split("\n")[0]); } \
      try { const Database=require("better-sqlite3"); const vec=require("sqlite-vec"); const db=new Database(":memory:"); vec.load(db); db.close(); console.log("[gate] sqlite-vec loads", vec.getLoadablePath()); } \
      catch (e) { bad=1; console.log("[gate] sqlite-vec DOES NOT LOAD:", String(e.message).split("\n")[0]); } \
      try { require("onnxruntime-node"); console.log("[gate] onnxruntime-node loads"); } \
      catch (e) { bad=1; console.log("[gate] onnxruntime-node DOES NOT LOAD:", String(e.message).split("\n")[0]); } \
      process.exit(bad);'

# An empty directory to COPY into the runtime stage as /data. Distroless has no
# shell, so it cannot be created there; a fresh named volume inherits this
# directory's ownership (10001:10001 below), which is what lets the runtime user
# write `data.db` without the operator chowning anything.
RUN mkdir -p /empty-data


# Distroless keeps glibc (so the prebuilt onnxruntime-node / better-sqlite3 /
# sqlite-vec binaries work unchanged) while dropping the shell + apt userland.
# No shell means: numeric USER (no useradd), exec-form HEALTHCHECK.
FROM gcr.io/distroless/nodejs22-debian12 AS runner

LABEL rembric.stage=runtime

WORKDIR /app

COPY --from=builder --chown=10001:10001 /runtime ./
# `lib/version.ts` reads `apps/web/package.json` by computed path, so Next's tracer never
# sees it. That manifest IS the release identity release-please bumps and tags
# `server-v<version>`; without this copy the standalone tree has no manifest at the
# walk-up root and the brand falls back to the `0.0.0` sentinel. The build gate above
# checks this exact file.
COPY --from=builder --chown=10001:10001 /app/apps/web/package.json ./apps/web/package.json
# The standalone entrypoint. It resolves `REMBRIC_PORT` (the variable the Compose
# mapping and the installer use) into the `PORT` the generated server reads, then
# loads `next-server.js`. Placed at the path the publish smoke test asserts, which
# is why the generated server was renamed during the assembly step above.
COPY --from=builder --chown=10001:10001 /app/apps/web/server.js ./apps/web/server.js
# Next does not put these in the standalone output; it documents copying them
# next to the server, which is the same `apps/web` directory here.
COPY --from=builder --chown=10001:10001 /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=10001:10001 /app/apps/web/public        ./apps/web/public
# The embedder resolves `/app/models` (packages/core/src/embeddings/embedder.ts).
COPY --from=builder --chown=10001:10001 /models                     ./models
COPY --from=builder --chown=10001:10001 /empty-data                 /data

USER 10001:10001

# HOSTNAME is what the generated server reads (its default is 0.0.0.0 anyway);
# REMBRIC_HOST/REMBRIC_PORT are what the app itself reports. The launcher reads
# REMBRIC_PORT first and then PORT, so REMBRIC_PORT remains the single source of
# truth for the listen port while both keep their historical default. Docker
# honours an image ENV HOSTNAME.
ENV REMBRIC_DATA_DIR=/data \
    REMBRIC_HOST=0.0.0.0 \
    REMBRIC_PORT=8787 \
    PORT=8787 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8787

# Absolute node path: distroless ships it at /nodejs/bin/node and does not
# guarantee a bare `node` on PATH. The start period is longer than the server
# image's: the first boot applies migrations and starts the reaper/embedder
# timers before it accepts connections. The probe runs the same launcher, so it
# targets the env-derived port instead of the 8787 default a customised
# installation does not listen on.
HEALTHCHECK --interval=30s --timeout=3s --retries=5 --start-period=20s \
  CMD ["/nodejs/bin/node", "/app/apps/web/server.js", "--healthcheck"]

ENTRYPOINT ["/nodejs/bin/node", "/app/apps/web/server.js"]
