## Why

Today Rembric ships as an npm package: `pnpm dlx rembric` or `pnpm add -g rembric` + manual `REMBRIC_ADMIN_TOKEN` export. That path forces every operator to install Node 20+, compile two native modules (`better-sqlite3`, `sqlite-vec`), and keep the local toolchain matched to the server's expectations. For a single-author project the author runs across a Mac dev box and a LXC server, this is the friction surface where every upgrade introduces "did the native build break under Node 22?" risk.

Docker collapses that surface. One process, one SQLite file, one bind-mount, one published image. The operator pulls `ghcr.io/susomejias/rembric:<tag>`, edits `.env`, runs `docker compose up -d`. Native modules are pre-built inside the image, locked to the same Node version the maintainer used. Rollback is `REMBRIC_VERSION=<prev>` and `docker compose up -d`. Self-hosted UX caught up with the project's "single-operator, multi-host" reality.

The change also future-proofs the project for opening to others later: the canonical install path stops requiring `pnpm` knowledge, the LXC scenario gets first-class documentation, and a private GHCR repository can flip to public the day the author decides to open the project — no migration in either direction.

npm publishing is NOT removed in this change. The package keeps shipping to GitHub Packages so the native CLI (`rembric token create`, etc.) stays invocable on hosts that already have Node. The author has explicitly recorded the intent to consolidate to a single distribution path post-open-source (see memory `distribution-strategy`); this proposal captures that as a deferred decision, not an executed one.

## What Changes

- **DISTRIBUTION** Rotate the canonical install path to Docker. The README's Quickstart SHALL lead with `docker compose up -d`; the `pnpm dlx rembric` path SHALL move to a "Power users" subsection under Development.
- **PACKAGING** Ship a multi-stage `Dockerfile` (builder + runtime, `node:20-bookworm-slim` base, non-root user, multi-arch `linux/amd64` + `linux/arm64`) at the repo root. The runtime image sets `REMBRIC_DATA_DIR=/data`, `REMBRIC_HOST=0.0.0.0`, `REMBRIC_PORT=8787`, exposes `8787`, declares `VOLUME /data`, and runs `node /app/dist/cli.js start` as PID 1.
- **PACKAGING** Ship a canonical `docker-compose.yml` at the repo root that pins `image: ghcr.io/susomejias/rembric:${REMBRIC_VERSION:-latest}`, binds `127.0.0.1:${REMBRIC_PORT:-8787}:8787`, bind-mounts `./data:/data`, sources `env_file: .env`, declares `restart: unless-stopped`, includes `extra_hosts: ["host.docker.internal:host-gateway"]`, and defines a `healthcheck` consistent with the Dockerfile's `HEALTHCHECK`.
- **PACKAGING** Ship a sibling `docker-compose.build.yml` override that adds `build: .` for operators who want to build from source.
- **PACKAGING** Ship `.env.example` covering: `REMBRIC_ADMIN_TOKEN` (required, with one-liner generation hint), `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`/`OPENAI_EMBEDDING_MODEL`, `REMBRIC_VERSION` (commented), `REMBRIC_PORT`/`LOG_LEVEL` (commented common toggles), and pointers to advanced env vars in `docs/configuration.md`.
- **PACKAGING** Add `.dockerignore` excluding `node_modules`, `dist`, `.git`, tests, OpenSpec, docs, hermes-tests, and other build-time-only paths.
- **GITIGNORE** Add `*.local.*` to `.gitignore` so operators (including the author) can keep personal notes alongside the repo without polluting commits. `data/` and `.env`/`.env.*` are already excluded.
- **REGISTRY** Publish the image to GitHub Container Registry at `ghcr.io/susomejias/rembric` with the matrix `:<x.y.z>`, `:<x.y>`, `:<x>`, `:latest`, `:sha-<7>` on each release. The image SHALL remain `private` while the repo is private; visibility flips when the repo is opened. Immutable tags (`:<x.y.z>`, `:sha-<7>`) SHALL fail the publish workflow if they already exist for the same name (no silent overwrite).
- **CI** Add `.github/workflows/docker-publish.yml` with `workflow_dispatch` and `release` (created) triggers, using `docker/build-push-action` with multi-arch buildx, the immutability guard, and authentication via `${{ secrets.GITHUB_TOKEN }}` against GHCR.
- **HEALTH** Harden the existing `GET /healthz` from `{ ok: true }` unauthenticated to a bearer-gated, version-bearing endpoint that runs a `SELECT 1` and returns `200 { ok: true, version: "<x.y.z>" }` on DB success, `503 { ok: false }` on DB failure, and `401` without/with invalid auth. Auth uses the same bearer mechanism as `/mcp` and `/api`. The Dockerfile/compose healthcheck SHALL pass the admin token via `Authorization: Bearer ${REMBRIC_ADMIN_TOKEN}`.
- **PLUGIN** Update the Hermes provider's `is_available()` to send `Authorization: Bearer ${REMBRIC_API_TOKEN}` on its `GET /healthz` probe to match the new auth contract. Bump all three plugin manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`) from `0.5.0` to `0.6.0` in lock-step.
- **DOCS** Rewrite `README.md` Quickstart to lead with Docker (same-host AND LXC scenarios), add an "Upgrading" section explaining the `:latest` flow via Portainer/Arcane, demote npm to a "Power users / direct Node" subsection, update the architecture diagram caption to note Docker is the canonical packaging.
- **DOCS** Add `docs/docker.md` covering both topologies, the `host.docker.internal` trap on Linux, named-volume vs bind-mount trade-off, the SQLite-on-NFS warning, backup recipe, and the rollback procedure.
- **DOCS** Update `docs/agents.md` Hermes section to reflect the auth header on `is_available`.
- **CHANGELOG** Add `plugin/CHANGELOG.md` entry for `0.6.0` calling out the Hermes provider auth header change.

## Out of scope

- **Removing the npm publish path.** Explicitly deferred to a future change `sunset-npm-distribution`, opened once the project is public and the dual-publish discipline has run its course. The author's intent is recorded; the execution is not part of this change.
- **Auto-generating `REMBRIC_ADMIN_TOKEN` on first boot.** Considered and rejected (2026-05-17): the author prefers the existing explicit-setup behavior. The server continues to fail verbosely when the env is absent.
- **Adding a rich `/healthz/detail` endpoint with counters.** Considered and rejected (2026-05-17): minimalismo por defecto. If rich monitoring becomes a real need, a follow-up change adds it on its own merits.
- **Bundling Ollama or any other LLM in compose.** The `.env.example` documents `host.docker.internal` for "Ollama on the host"; bundling adds GB of image weight and forces a model choice the operator should make.
- **Custom Docker network, resource limits, or distroless base.** Out of scope for V1 — default bridge, no limits, `bookworm-slim` are the right defaults for self-hosted single-operator and reduce maintenance surface.
- **VACUUM on container restart.** SQLite auto-vacuum is the operator's call.
- **HTTPS termination / reverse proxy config.** The server keeps binding HTTP; the operator owns TLS via their reverse proxy of choice.
- **Watchtower or any auto-update agent.** The `:latest` tag is published so the operator's Docker manager (Portainer/Arcane) can detect updates; auto-pull on top is the operator's opt-in.
- **A `rembric` CLI command that talks to a running Docker container from outside.** Out of scope. `docker exec` is the canonical pattern; an HTTP-only CLI is a future change.

## Capabilities

### New Capabilities

None. Docker packaging adds no new behavioral capability — it changes how the existing behavior is delivered.

### Modified Capabilities

- `http-api`: add `/healthz` as a formally specified endpoint (was an undocumented implementation detail in `src/server/http.ts`), with bearer auth, DB ping, version field, and 503 path.
- `hermes-agent-plugin`: modify the `is_available` sub-bullet of "Provider lifecycle method behavior" to send `Authorization: Bearer ${REMBRIC_API_TOKEN}` on the `/healthz` probe.

## Impact

- **New files**:
  - `Dockerfile`
  - `.dockerignore`
  - `docker-compose.yml`
  - `docker-compose.build.yml`
  - `.env.example`
  - `docs/docker.md`
  - `.github/workflows/docker-publish.yml`
- **Modified files**:
  - `src/server/http.ts` — replace the existing `GET /healthz` handler with the bearer-gated, DB-ping, version-bearing variant
  - `src/server/auth.ts` (or wherever bearer extraction lives) — wire `/healthz` through the same path as `/api` and `/mcp`
  - `plugin/.hermes-plugin/__init__.py` — add `Authorization` header to `is_available`'s `GET /healthz`
  - `plugin/.claude-plugin/plugin.json` — bump version `0.5.0` → `0.6.0`
  - `plugin/.codex-plugin/plugin.json` — bump version `0.5.0` → `0.6.0`
  - `plugin/.hermes-plugin/plugin.yaml` — bump version `0.5.0` → `0.6.0`
  - `plugin/CHANGELOG.md` — add `0.6.0` entry
  - `package.json` — bump version `0.12.0` → `0.13.0`
  - `README.md` — Quickstart Docker-first; npm path demoted; LXC topology section
  - `docs/agents.md` — Hermes auth header update
  - `.gitignore` — add `*.local.*` line
  - `openspec/specs/http-api/spec.md` — generated by archiving (deltas → main spec)
  - `openspec/specs/hermes-agent-plugin/spec.md` — generated by archiving (deltas → main spec)
  - `openspec/changes/make-docker-primary-distribution/` — this proposal + design + tasks + spec deltas
- **No changes**:
  - `src/services/*`, `src/db/*`, `src/mcp/*`, `src/dashboard/*`, `src/consolidation/*` — packaging change only
  - Plugin scripts (`plugin/scripts/*.sh`) — they already read `REMBRIC_*` from env regardless of how it got there
  - Plugin bridge (`plugin/bin/rembric-bridge.mjs`) — unchanged
  - The four load-bearing invariants (append-only, scope, topic_key, fresh-context judgment) — untouched
  - npm publish workflow (`prepack`, `publishConfig`) — preserved for the dual-publish phase
