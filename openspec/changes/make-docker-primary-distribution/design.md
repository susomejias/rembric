## Context

Rembric's distribution today is npm-first: `pnpm dlx rembric` or `pnpm add -g rembric` against GitHub Packages. The package ships `dist/` plus two native dependencies (`better-sqlite3`, `sqlite-vec`) that compile or load platform-specific binaries on install. The operator runs `rembric start`, the server opens `~/.rembric/data.db`, and the agent client (Claude Code / Codex / Hermes) talks to it over HTTP from the same host or across a LAN.

This worked when the project was a one-machine experiment. It strains now that the author's operational reality is:

- Dev work on a Mac (Apple Silicon).
- A LXC server running Rembric 24/7 with Hermes co-located.
- Plugin clients on multiple machines pointing at one canonical server.

Three pain points compound:

1. **Native module risk.** Every Node 20 → 22 upgrade is a roll of the dice on whether `better-sqlite3` or `sqlite-vec` prebuilts catch up. Across two machines, that's two failure modes per upgrade.
2. **Reproducibility.** `pnpm dlx rembric` resolves the latest published version against the current Node + libc. Six months from now, "spin up Rembric to remember how I set X up" depends on a chain of factors that decay.
3. **LXC story is underbaked.** The README assumes localhost; the author's actual deployment lives on a different host and requires undocumented env wrangling (which port, which IP, how the plugin reaches it).

Docker collapses all three. The image is a frozen artifact, native modules are pre-built inside it, the upgrade path is `docker pull` + `compose up -d`, and the LXC topology becomes a first-class section in the docs.

This change is **packaging + distribution**, not behavior. The four load-bearing invariants (append-only memory, scope enforcement, convergent topics via `topic_key`, fresh-context judgment) are untouched. The only server-side behavior change is hardening `/healthz` — an endpoint that today serves `{ ok: true }` unauthenticated and needs to grow auth + a DB ping + a version field for the Docker `HEALTHCHECK` to be meaningful and consistent with the rest of the project's auth posture.

## Goals / Non-Goals

**Goals:**

- Make `docker compose up -d` the canonical install path for new operators.
- Preserve the npm path during the transition (dual-publish phase) so the native CLI stays usable.
- Publish a versioned image to GHCR with both rolling (`:latest`) and immutable (`:<x.y.z>`, `:sha-<7>`) tags.
- Support both deployment topologies (same-host and remote LXC) in the docs without forking the compose file.
- Harden `/healthz` to be a real, auth-gated availability probe with a DB ping.
- Capture the deferred decision to sunset npm, with the reasoning, so the next maintainer (often the author returning months later) doesn't relitigate it.

**Non-Goals:**

- Eliminating npm publishing in this change. Deferred (see Decision 10).
- Auto-generating the admin token (rejected by the author 2026-05-17).
- Rich monitoring endpoints (rejected — minimalismo).
- Bundling LLM runtimes, reverse proxies, or auto-update agents.
- A new "distribution" capability spec. The two spec deltas (`http-api`, `hermes-agent-plugin`) capture the only behavioral changes; everything else is packaging.

## Decisions

### Decision 1: Docker = canonical, npm = secondary, sunset deferred

The README's primary install path becomes Docker. npm publishing stays alive for the dual-publish phase to preserve the native CLI (`rembric token create`, `rembric project create`, etc.) and to honor the existing `@susomejias/rembric` consumers (whose count is currently ~0 because the repo is still private, but the contract exists). The author's intent to consolidate to one path is captured in memory (`distribution-strategy`) and will be executed in a separate change `sunset-npm-distribution` post-open-source. This change does NOT execute the sunset; it just makes Docker the path everyone reads first.

### Decision 2: Image tagging — publish ALL formats per release

Each release publishes:

- `ghcr.io/susomejias/rembric:<x.y.z>` (immutable)
- `ghcr.io/susomejias/rembric:<x.y>` (floats within minor)
- `ghcr.io/susomejias/rembric:<x>` (floats within major)
- `ghcr.io/susomejias/rembric:latest` (floats to latest release)
- `ghcr.io/susomejias/rembric:sha-<short>` (immutable, per-commit)

Earlier discussion considered "no `:latest` ever" — rejected. The author's operational reality is a Docker manager (Portainer / Arcane) that detects updates via tag digest change. Without a rolling tag, every upgrade forces a manual `.env` edit, which kills the UX. `:latest` IS published; operators who want reproducible deploys pin `REMBRIC_VERSION=<x.y.z>` in `.env`. The README documents both modes.

The publish workflow SHALL refuse to overwrite an existing immutable tag (`:<x.y.z>`, `:sha-<7>`). Concretely: a `docker manifest inspect` precheck fails the job before `docker buildx build --push` can clobber. This preserves the integrity of "if you pinned `:0.13.0`, you get exactly what was built for `:0.13.0`".

### Decision 3: Image base = `node:20-bookworm-slim`, multi-stage, multi-arch

- **Bookworm-slim, not Alpine.** `better-sqlite3` prebuilts target glibc; Alpine (musl) forces compilation from source every build. Bookworm-slim adds ~50MB over Alpine but eliminates the toolchain in the runtime stage entirely. Trade accepted.
- **Multi-stage.** Builder stage installs `build-essential` + `python3` + pnpm + dependencies + builds `dist/`; runtime stage copies only `dist/`, `node_modules` (after `pnpm prune --prod`), and `package.json`. Runtime image targets ~180–220MB.
- **Multi-arch from day 1.** `linux/amd64` + `linux/arm64`. `better-sqlite3` and `sqlite-vec` ship prebuilts for both. The author has both ARM (Mac/LXC depending) and AMD64 hosts; canonical compose pulls the right manifest automatically.
- **Non-root user.** `useradd -r -u 10001 -m rembric`. The container runs as UID 10001 to avoid root-owned files in bind-mounted volumes. Documented in `docs/docker.md` with the `chown` recipe for Linux operators whose host UID differs.

### Decision 4: `docker-compose.yml` is the canonical operator UX, not raw `docker run`

The README never shows a bare `docker run` command. Operators get:

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

Rationale: a bare `docker run` would need to embed every flag the compose file declares (port mapping, volume, env file, healthcheck, restart policy, extra_hosts). It's error-prone and not how self-hosted is consumed in 2026. Compose is the lingua franca.

The compose file:

- Uses `image:` not `build:` by default. Building from source is an opt-in via `docker-compose.build.yml` override (`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`). The default operator path NEVER builds locally.
- Binds `127.0.0.1:${REMBRIC_PORT:-8787}:8787` by default — preserves the loopback-only security posture. The LXC operator overrides via `docker-compose.override.yml` (gitignored) or by editing the line locally.
- Bind-mounts `./data:/data` (relative to the compose file). Visible, inspectable, easy to back up. The named-volume alternative is mentioned in `docs/docker.md` for operators who prefer Docker-managed volumes.
- Includes `extra_hosts: ["host.docker.internal:host-gateway"]`. No-op on Mac/Win where the host is auto-resolvable; resolves the most common "Ollama on host can't reach the container" trap on Linux. Adding this line costs nothing on any platform.
- Defines a `healthcheck:` that mirrors the Dockerfile's `HEALTHCHECK` but is explicit in compose. Compose's healthcheck takes precedence if both are present; this avoids surprises.

### Decision 5: `.env.example` is curated, not exhaustive

The example file lists:

- Required: `REMBRIC_ADMIN_TOKEN` (with one-liner generation hint), `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`/`OPENAI_EMBEDDING_MODEL`.
- Pinning: `REMBRIC_VERSION` (commented out; default unpinned = `:latest`).
- Common toggles commented: `REMBRIC_PORT`, `LOG_LEVEL`, `EMBEDDING_ENABLED`, `CONSOLIDATION_ENABLED`.

NOT listed (intentionally):

- `REMBRIC_HOST` — the Dockerfile pins it to `0.0.0.0`; changing it inside the container would break the published-port contract.
- `REMBRIC_DATA_DIR` — the Dockerfile pins it to `/data`; the bind-mount is the canonical path.
- `REMBRIC_SESSION_SECRET` — optional, derives from admin token.
- All consolidation tunables, rate-limit knobs, candidate thresholds — pointed at `docs/configuration.md` to avoid `.env.example` becoming a config reference.

The principle: an operator setting up Rembric for the first time SHOULD NOT have to think about what `JUDGMENT_ORPHAN_AFTER_MS` does. Power users find the docs.

### Decision 6: `/healthz` is bearer-gated, minimal, with a DB ping

Today's `/healthz` (`src/server/http.ts:65`) returns `{ ok: true }` unauthenticated. That's inconsistent with the project's posture (every other endpoint — `/mcp`, `/api`, `/admin`, `/dashboard` — is auth-gated) and useless as a real availability probe (no DB ping).

The hardened endpoint:

- Requires `Authorization: Bearer <token>` (any valid token, including project-scoped, because availability is not a project-scoped concern). Missing/invalid auth → `401 { ok: false, code: 'missing_token' | 'token_invalid' }`.
- On auth success, runs `SELECT 1` against the SQLite connection. On success: `200 { ok: true, version: "<x.y.z>" }`. On DB failure (timeout, locked, IO error): `503 { ok: false, code: 'db_unavailable' }`.
- No counters, no schema version field, no embedding backlog, no caching. ~15 lines of server code.
- The Docker `HEALTHCHECK` in the Dockerfile passes `Authorization: Bearer ${REMBRIC_ADMIN_TOKEN}` from the container's env. The container has the token (operator put it in `.env`), so the header is available without extra wiring.

**Breaking-change implication:** the Hermes provider's `is_available` today does an unauth `GET /healthz`. After this change it will see `401` and degrade its `is_available` to `False`. The fix is small (add `headers={"Authorization": f"Bearer {api_token}"}` to the `urllib` call) but it MUST ship together with the server change, otherwise Hermes silently turns off its memory provider. The Hermes provider already has `REMBRIC_API_TOKEN` in env (required for every other call), so no new config is needed. All three plugin manifests bump in lock-step per the existing version-coupling rule (`openspec/specs/hermes-agent-plugin/spec.md::"Version coupling with other client manifests"`).

### Decision 7: Admin token stays explicit (no auto-gen)

Rejected by the author 2026-05-17. The current behavior is preserved: if `REMBRIC_ADMIN_TOKEN` is unset on first boot, the server exits non-zero with a clear stderr message. The Quickstart in the README walks the operator through `openssl rand -hex 32` and pasting the result into `.env`.

Rationale: the author prefers explicit setup to magic. An auto-generated token that's printed once to logs is a foot-gun (lost on log rotation, never makes it into the operator's password manager). Better to make the operator do the deliberate act.

### Decision 8: Both deployment topologies are first-class

The README's "Quickstart" demonstrates the same-host case (loopback, `127.0.0.1:8787`). The README's "Running on a remote host (LXC, NAS, server)" section demonstrates:

- Editing the compose file's port binding to `0.0.0.0:8787:8787` (or using `docker-compose.override.yml` if the operator wants the canonical file untouched).
- Pointing the plugin's `REMBRIC_SERVER_URL` at `http://<host-ip>:8787` or `http://rembric.tailnet:8787`.
- The author's recommended path: Tailscale or WireGuard for cross-host links, never raw LAN exposure without TLS — operator's call which one.

`docs/docker.md` carries the detail (Tailscale ACL example, firewall snippets, etc.). The README has the topology dia­gram + minimal example.

### Decision 9: Migration from `~/.rembric` to Docker is operator-specific, not repo-documented

The author has accumulated memory in `~/.rembric/data.db` from the npm-installed server. The migration to Docker is a copy of three files (`data.db`, `data.db-shm`, `data.db-wal`) into `./data/` plus an `.env` setup. This is documented in a gitignored `.local.txt` in the author's working tree, NOT in `docs/`.

Rationale: every other operator who installs Rembric starts fresh — they don't have a `~/.rembric` to migrate. Documenting "if you used to have the npm install, here's how to move" in the public docs is noise that ages badly. The `.gitignore` pattern `*.local.*` (introduced in this change) covers personal notes alongside the repo without polluting commits.

### Decision 10: npm sunset is a future change, with intent recorded

This change does NOT remove npm publishing. The author has explicitly recorded the intent to consolidate to a single path (Docker) post-open-source, captured in memory (`distribution-strategy`). The follow-up change `sunset-npm-distribution` will:

- Remove `prepack` build hook from `package.json`.
- Remove `publishConfig` from `package.json`.
- Remove npm-publish workflow from CI.
- Update release-please config to stop bumping the npm version field (or rather: stop publishing on its bump).
- Update README to declare the npm path deprecated with a sunset date.
- Document the migration of the `rembric ...` CLI invocations to `docker exec rembric rembric ...`.

The reasoning is captured here so the future change can reference this design.md instead of relitigating "should we keep npm". The answer is **no, in the long run** — but **yes, during the dual-publish window** to preserve the existing contract and avoid the foot-gun of yanking the package before the Docker path is proven in the wild.

### Decision 11: GHCR image starts private, flips to public later

The image is published to `ghcr.io/susomejias/rembric` with `private` visibility until the author opens the project. Visibility is a one-line flip in the package settings; no migration, no URL change, no tag re-publishing. The CI workflow uses `${{ secrets.GITHUB_TOKEN }}` which has implicit write access to GHCR for the repository owner — no extra PAT needed.

Operators pulling the private image authenticate with a PAT (`docker login ghcr.io -u <user> --password-stdin`), one-time setup. This is documented in `docs/docker.md` and called out in the README's "Quickstart" section with a fallback note ("If you're an early access user, see `docs/docker.md` for the GHCR auth step").

## Risks / Trade-offs

- **Image size.** `~180-220MB` is heavier than a hypothetical Alpine + `apk add sqlite-vec` route. The trade is "consistently fast pulls + no compile risk" vs "smaller image but build flakiness on every release". Self-hosted bandwidth is rarely the bottleneck.
- **Multi-arch CI time.** Building `amd64` + `arm64` doubles workflow runtime (~5–10 min total). Acceptable for non-frequent releases.
- **`:latest` race during release.** If an operator runs `docker compose pull` during the few seconds between the new image being pushed and the new immutable `:<x.y.z>` tag being available, they might get a digest mismatch on the next pull. Probability is tiny and self-corrects on the next pull. Not worth engineering around.
- **Hermes provider breaks if upgraded out of order.** If the operator updates the server to the new `/healthz` auth contract WITHOUT updating the Hermes plugin (`0.5.0` still in use), Hermes's `is_available` returns False and the memory provider silently disables. Mitigation: the plugin's existing version-coupling spec already requires all three manifests to bump in lock-step, and `plugin/CHANGELOG.md::0.6.0` calls this out explicitly. Operators reading the upgrade notes will know.
- **GHCR private auth foot-gun.** While the image is private, every operator must `docker login ghcr.io` once. If the PAT lacks `read:packages`, the pull fails with an opaque "manifest unknown" error. Documented prominently in `docs/docker.md`.
- **Bind-mount UID mismatch on Linux.** The container runs as UID 10001; if the host UID is different and the bind-mounted `./data/` was pre-populated by the host user, the container can't write. Documented in `docs/docker.md` with the `chown` recipe.
- **Compose file in the repo root.** Mounts `./data` relative to the compose file location. If the operator moves the compose file elsewhere, the volume path moves with it (silently). Documented.

## Migration Plan

For the author (single existing operator):

1. Take a backup of `~/.rembric/`.
2. Stop the running npm-installed server.
3. Copy `~/.rembric/data.db*` to `./data/` in the repo.
4. Set up `.env` with the same admin token as before.
5. `docker compose up -d`.
6. Smoke test: bearer-gated `curl /healthz`, dashboard login, `/rembric:context` from a Claude Code session.
7. Archive the old install once Docker proves stable for a few sessions.

The full recipe lives in `migrate-to-docker.local.txt` (gitignored). Rollback is "stop the container, restart the npm server, point the plugin back" — `~/.rembric/` is unmodified by the migration.

For future operators (post-open-source): there is no migration. They install Docker fresh and start with an empty `./data/`.

## Open Questions

- **Should `docker-compose.yml` bind `127.0.0.1:8787:8787` or `0.0.0.0:8787:8787` by default?** Decided: `127.0.0.1`. Preserves the loopback-only posture; LXC operators override. The README's LXC section explains how. (Locked into this design 2026-05-17.)
- **Should the `:latest` tag float across major versions or only minor?** Floating across major means a `docker pull rembric:latest` after a v2.0.0 release pulls a breaking change. Today: floats across all (true latest). If breaking changes become common, this can be revisited — but the project's discipline of bumping plugin manifests in lockstep makes "silent breakage" unlikely.
- **Should `docs/docker.md` include a Watchtower section?** Today: no. Watchtower auto-pulls `:latest` which is dangerous if a breaking change ships. When the project matures and releases stabilize, the Watchtower path can be added as an opt-in. Captured in memory `docker-image-tagging-strategy` as "desaconsejado por ahora".
- **When to flip GHCR visibility from private to public?** When the author opens the GitHub repo to public visibility. Not part of this change.
- **Should there be a `docker compose down && docker volume prune` recipe documented?** Decided: no, in the canonical docs. The bind-mount is the operator's call to delete; Docker won't touch `./data/` without explicit removal.
