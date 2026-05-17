## 1. Dockerfile + image build

- [x] 1.1 Create `Dockerfile` at the repo root with two stages:
  - **Builder** (`FROM node:20-bookworm-slim AS builder`):
    - `apt-get install -y --no-install-recommends build-essential python3 ca-certificates && rm -rf /var/lib/apt/lists/*`.
    - `corepack enable && corepack prepare pnpm@9.12.0 --activate`.
    - `WORKDIR /app`.
    - Copy `package.json` + `pnpm-lock.yaml`; `pnpm install --frozen-lockfile`.
    - Copy the rest of the source; `pnpm run build && pnpm prune --prod`.
  - **Runtime** (`FROM node:20-bookworm-slim AS runtime`):
    - `useradd -r -u 10001 -m rembric`.
    - `WORKDIR /app`.
    - Copy `--from=builder --chown=rembric:rembric` `/app/dist`, `/app/node_modules`, `/app/package.json`.
    - `USER rembric`.
    - `ENV REMBRIC_DATA_DIR=/data REMBRIC_HOST=0.0.0.0 REMBRIC_PORT=8787`.
    - `VOLUME ["/data"]`.
    - `EXPOSE 8787`.
    - `HEALTHCHECK --interval=30s --timeout=3s --retries=3 --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{Authorization:'Bearer '+process.env.REMBRIC_ADMIN_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
    - `ENTRYPOINT ["node", "/app/dist/cli.js"]`.
    - `CMD ["start"]`.
- [x] 1.2 Create `.dockerignore` at the repo root excluding: `node_modules`, `dist`, `.git`, `.github`, `.husky`, `coverage`, `**/*.tsbuildinfo`, `data/`, `.env*`, `*.local.*`, `openspec/`, `docs/`, `examples/`, `plugin/.hermes-plugin-tests/`, `**/*.test.ts`, `**/__tests__/`, `**/.DS_Store`.
- [x] 1.3 Local sanity build: `docker buildx build --platform linux/amd64,linux/arm64 -t rembric:dev .`. Verified 2026-05-17 on Docker Desktop 29.4.1 with `rembric-multiarch` docker-container builder. Both arches build cleanly; arm64-only build loaded into local engine runs `--help` correctly (257MB image). Side fix: `pnpm prune --prod` ran `husky` postinstall and broke; replaced with `rm -rf node_modules && pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm rebuild better-sqlite3 sqlite-vec`.

## 2. docker-compose.yml + .env.example

- [x] 2.1 Create `docker-compose.yml` at the repo root:
  - `services.rembric.image: ghcr.io/susomejias/rembric:${REMBRIC_VERSION:-latest}`.
  - `services.rembric.container_name: rembric`.
  - `services.rembric.restart: unless-stopped`.
  - `services.rembric.ports: ["127.0.0.1:${REMBRIC_PORT:-8787}:8787"]`.
  - `services.rembric.volumes: ["./data:/data"]`.
  - `services.rembric.env_file: [".env"]`.
  - `services.rembric.extra_hosts: ["host.docker.internal:host-gateway"]`.
  - `services.rembric.healthcheck`: same `CMD` array as the Dockerfile `HEALTHCHECK` (auth header sourced from container env).
  - NO `version:` key (Compose v2 ignores it).
- [x] 2.2 Create `docker-compose.build.yml` at the repo root with just `services.rembric.build: .` so operators can override with `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
- [x] 2.3 Create `.env.example` at the repo root with the curated set defined in `design.md::Decision 5`. Required vars uncommented (empty values); pinning + common toggles commented out with brief inline notes; pointer to `docs/configuration.md` for advanced knobs.
- [x] 2.4 Add `*.local.*` line to `.gitignore` (already done in this branch via prior edit; verify it survives commit).
- [x] 2.5 Smoke test: verified 2026-05-17 on Docker Desktop 29.4.1. `cp .env.example .env`, populated REMBRIC_ADMIN_TOKEN via `openssl rand -hex 32`, `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`. Container reached `healthy` in ~15s, server emitted the expected boot banner with `Healthcheck: http://0.0.0.0:8787/healthz (bearer token required)`, bind-mount `./data/` created with `data.db` + WAL + SHM files.

## 3. /healthz hardening (server-side)

- [x] 3.1 Modify `src/server/http.ts`: replace `honoApp.get('/healthz', (c) => c.json({ ok: true }));` with a handler that:
  - Reads `Authorization: Bearer <token>` from the request. If missing/malformed, return `401 { ok: false, code: 'missing_token' }`.
  - Validates the token through the same `authenticate()` path used by `/api` and `/mcp`. If invalid/revoked/expired, return `401 { ok: false, code: 'token_invalid' }`.
  - Runs `SELECT 1` against the SQLite connection (use `db.get` from drizzle or the raw `better-sqlite3` handle, whichever is the cheapest in scope).
  - On success: `200 { ok: true, version: '<package.json version>' }`.
  - On DB failure: `503 { ok: false, code: 'db_unavailable' }`.
- [x] 3.2 Wire the package.json version through to runtime. If a `VERSION` constant doesn't already exist, add `src/version.ts` exporting `export const REMBRIC_VERSION = '<x.y.z>'` (or read from `package.json` at startup) and import it in the `/healthz` handler.
- [x] 3.3 Co-located test `src/server/http.test.ts` (or extend existing): missing header → 401; invalid token → 401; valid token + healthy DB → 200 with `ok:true` and `version`; DB down (simulate by closing the connection) → 503.
- [x] 3.4 Update the bootstrap log line `src/server/bootstrap.ts:244` ("Healthcheck: …/healthz") to mention auth is required ("Healthcheck: …/healthz (bearer token required)").

## 4. Hermes provider update (auth header on is_available)

- [x] 4.1 Modify `plugin/.hermes-plugin/__init__.py::is_available`: add `Authorization: Bearer ${REMBRIC_API_TOKEN}` to the `urllib` request. Handle the case where `REMBRIC_API_TOKEN` is unset — return `False` (matching the existing degradation behavior).
- [x] 4.2 Update `plugin/.hermes-plugin-tests/` to cover: token unset → False; token set + 200 → True; token set + 401 → False; token set + 503 → False.
- [x] 4.3 Run `python3 -m unittest discover -s plugin/.hermes-plugin-tests -v` to confirm green.

## 5. Plugin version bumps + changelog

- [x] 5.1 Bump `plugin/.claude-plugin/plugin.json` version: `0.5.0` → `0.6.0`.
- [x] 5.2 Bump `plugin/.codex-plugin/plugin.json` version: `0.5.0` → `0.6.0`.
- [x] 5.3 Bump `plugin/.hermes-plugin/plugin.yaml` version: `0.5.0` → `0.6.0`.
- [x] 5.4 Add `plugin/CHANGELOG.md` entry under `## [0.6.0] — unreleased`:
  - "Hermes provider: `is_available()` now sends `Authorization: Bearer ${REMBRIC_API_TOKEN}` to match the server's new `/healthz` auth contract. Operators upgrading from `0.5.x` MUST update server AND plugin together — running `0.5.x` Hermes against `0.13+` server will silently disable the memory provider (`is_available` returns `False`)."
  - "No changes to Claude Code or Codex CLI hooks/scripts — those plugins did not call `/healthz` directly."

## 6. Server version bump

- [x] 6.1 Bump `package.json` version: `0.12.0` → `0.13.0`. (release-please will normally do this on merge; for explicit changes that affect plugin compatibility, the bump goes in the same commit as the spec deltas.)
- [x] 6.2 Verify the version string flows through to `/healthz` (Task 3.2).

## 7. CI workflow

- [x] 7.1 Create `.github/workflows/docker-publish.yml`:
  - Triggers: `workflow_dispatch` (manual for iteration) AND `release.types: [created]` (auto on release-please tags).
  - Permissions: `contents: read`, `packages: write`.
  - Single job `build-and-push`:
    - `actions/checkout@v4`.
    - `docker/setup-qemu-action@v3` (for multi-arch).
    - `docker/setup-buildx-action@v3`.
    - `docker/login-action@v3` against `ghcr.io` with `${{ secrets.GITHUB_TOKEN }}`.
    - **Immutability guard**: a step that runs before push, computing `<x.y.z>` and `sha-<7>` from the workflow context, then `docker manifest inspect ghcr.io/${{ github.repository_owner }}/rembric:<x.y.z>` — if exit 0, fail the job with a clear message ("Tag already exists — refusing to overwrite").
    - `docker/metadata-action@v5` to compute the tag matrix: `type=semver,pattern={{version}}`, `type=semver,pattern={{major}}.{{minor}}`, `type=semver,pattern={{major}}`, `type=raw,value=latest`, `type=sha,format=short,prefix=sha-`.
    - `docker/build-push-action@v5` with `platforms: linux/amd64,linux/arm64`, `push: true`, `tags: ${{ steps.meta.outputs.tags }}`, `labels: ${{ steps.meta.outputs.labels }}`, `cache-from: type=gha`, `cache-to: type=gha,mode=max`.
- [ ] 7.2 Test the workflow via `workflow_dispatch` against a throwaway tag (`docker-test-<date>`) before relying on it. The throwaway tag SHALL be a `type=raw` value, NOT `:latest` — and SHALL be deleted from GHCR after verification.
- [ ] 7.3 Verify the image visibility in GHCR is `private` (org settings). Document the PAT requirement for early-access operators in `docs/docker.md`.

## 8. README rewrite

- [x] 8.1 Replace the existing "Quickstart" section with a Docker-first version:
  - Steps: clone (or download a release tarball when published), `cp .env.example .env`, edit `.env`, `docker compose up -d`, smoke check `/dashboard`.
  - Subsection "Running on the same host as your agent" (same-host topology, port binding `127.0.0.1:8787:8787`).
  - Subsection "Running on a remote host (LXC, NAS, server)" (LXC topology, port binding `0.0.0.0:8787:8787`, Tailscale recommendation, `REMBRIC_SERVER_URL` on the plugin side).
  - Subsection "Upgrading": `docker compose pull && docker compose up -d` (uses `:latest`); or bump `REMBRIC_VERSION` in `.env` + same commands (pinned). Notes Portainer/Arcane visibility of digest changes.
  - Subsection "Rollback": set `REMBRIC_VERSION=<x.y.z-prev>` in `.env`, `docker compose up -d`. The bind-mounted `./data/` is unchanged.
- [x] 8.2 Demote the npm path: rename "Quickstart" → "Quickstart (Docker)". Move the npm commands to a "Power users: install directly with pnpm" subsection under "Development". Keep `pnpm dlx rembric` documented; note it's the path for operators who already have Node 20+ and prefer the native CLI.
- [x] 8.3 Update the "Hooking up Claude Code", "Hooking up Codex CLI", "Hooking up Hermes Agent" sections to mention the new server URL conventions (loopback for same-host, `http://<host>:8787` for LXC). The plugin install commands themselves are unchanged.
- [x] 8.4 Add a "Backups" subsection explaining `cp ./data/data.db ./backups/data-$(date +%Y%m%d).db` (or `sqlite3 ./data/data.db .backup ./backups/...`). Warn against bind-mounting onto NFS.
- [x] 8.5 Update the architecture diagram caption to note "Single Node process — packaged as a Docker image; pnpm install supported as a power-user fallback."

## 9. docs/docker.md

- [x] 9.1 Create `docs/docker.md` covering:
  - Same-host vs LXC topology with diagrams.
  - The `host.docker.internal` extra_hosts entry — what it does on each platform.
  - Named-volume vs bind-mount trade-off; how to switch.
  - SQLite-on-NFS warning (locking guarantees, why to avoid).
  - Backup recipe (cp + sqlite3 .backup).
  - GHCR private-image auth: PAT scope (`read:packages`), `docker login ghcr.io`.
  - Upgrade flow with Portainer / Arcane (UI screenshots optional; CLI fallback `docker compose pull && up -d`).
  - Rollback to a pinned version.
  - Bind-mount UID mismatch troubleshooting (`chown -R 10001:10001 ./data` on Linux when needed).
- [x] 9.2 Cross-link from README's Quickstart and from `docs/agents.md`.

## 10. docs/agents.md update

- [x] 10.1 In the Hermes section, note that `is_available` now requires `REMBRIC_API_TOKEN` to send the bearer header. The env var was already required for every other Hermes call, so this is a tightening of existing behavior, not a new requirement.

## 11. OpenSpec spec deltas

- [x] 11.1 `openspec/changes/make-docker-primary-distribution/specs/http-api/spec.md` — add a new "ADDED Requirements" requirement formalizing `/healthz` (bearer-gated, version-bearing, DB-ping, 401/200/503 paths). Cover the four scenarios: no auth, invalid auth, valid auth + healthy DB, valid auth + DB down.
- [x] 11.2 `openspec/changes/make-docker-primary-distribution/specs/hermes-agent-plugin/spec.md` — add a "MODIFIED Requirements" entry for "Provider lifecycle method behavior", rewriting the `is_available` sub-bullet to require the Authorization header. The rest of the requirement is unchanged; the delta replaces only the sub-bullet's text.

## 12. Validation

- [x] 12.1 `pnpm run typecheck` green.
- [x] 12.2 `pnpm run lint` green.
- [x] 12.3 `pnpm test` green (includes co-located /healthz tests + Hermes Python unittests). 428/428 tests across 38 files.
- [x] 12.4 `openspec validate make-docker-primary-distribution --strict` green.
- [x] 12.5 Manual smoke test sequence: verified end-to-end 2026-05-17. `curl /healthz` without auth → 401; with `Authorization: Bearer <admin>` → 200 `{ok:true, version:"0.13.0"}`; `curl -L /dashboard/login` → 200. Bind-mount integrity confirmed (`./data/data.db` + WAL/SHM siblings present). Container tear-down clean (`docker compose down` removed network + container).
  - Build image locally: `docker buildx build --platform linux/arm64 -t rembric:test .`.
  - Run with the canonical compose: `REMBRIC_VERSION=test docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
  - Verify container reaches `healthy` state inside 60s (`docker compose ps`).
  - Verify dashboard login at `http://127.0.0.1:8787/dashboard/login` works with the admin token from `.env`.
  - Verify Claude Code plugin connecting to `http://127.0.0.1:8787` resolves `/rembric:context` correctly.
  - Verify Hermes provider's `is_available` returns True (requires running a Hermes session against the new server with plugin `0.6.0`).
- [ ] 12.6 Manual GHCR publish dry-run via `workflow_dispatch` against a throwaway tag, then delete the tag.

## 13. Post-merge follow-up (not part of this change)

- [ ] 13.1 When the project is opened: flip the GHCR image visibility from `private` to `public`, remove the PAT-auth note from `docs/docker.md`.
- [ ] 13.2 When ready to consolidate distribution: open the change `sunset-npm-distribution`. Reference this design.md::Decision 10.
