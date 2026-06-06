# Design: dashboard-self-update

## Context

Rembric ships exclusively as a Docker image (`ghcr.io/susomejias/rembric`), normally run via the repo's `docker-compose.yml` (`image: …:${REMBRIC_VERSION:-latest}`, `container_name: rembric`, `restart: unless-stopped`, non-root uid 10001, no Docker socket). The dashboard already displays the running version (`REMBRIC_VERSION` constant from `version.ts`, sourced from `package.json`) in the brand block. Operators currently discover releases by watching GitHub and update by running compose commands on the host.

Arcane's update flow is the UX reference: persistent sidebar badge → modal with version diff + changelog → one-click update → step progress (pull / restart / verify / reload). Arcane solves the "a process cannot outlive its own container" problem by launching an ephemeral upgrader container that performs the swap from outside.

Hard constraints from exploration:

- **Zero-action compatibility**: a deployment that only runs `docker compose pull && docker compose up -d` must keep working identically, with the feature simply `unavailable`. No config change may ever be required.
- The container runs as non-root with no Docker access by default; that posture must not change by default.
- Supply-chain posture: no new npm dependencies without strong justification (`.agents/skills/npm-security-best-practices/`).
- Name collision to keep straight: the `REMBRIC_VERSION` _constant_ is the running version (package.json); the `REMBRIC_VERSION` _env var_ (via `env_file: .env`) is the compose image-tag pin. They are different values with the same name.

## Goals / Non-Goals

**Goals:**

- Every deployment (no action taken) learns about new releases in the dashboard: badge + changelog modal + ready-to-paste update command + automatic post-update page reload.
- Deployments that opt in by mounting `/var/run/docker.sock` get Arcane-style one-click update: pull → SQLite backup → container swap with health-check and rollback → page reloads on the new version.
- Refuse one-click when the image tag is pinned, with an explanation, so a later `compose up` can never silently downgrade.
- No new dependencies, no DB schema changes, no change to MCP/memory semantics.

**Non-Goals:**

- Updating anything other than Rembric's own container (this is not a container manager).
- Automatic/unattended updates (cron-style). One-click is always operator-initiated behind a danger confirmation.
- Editing host files (`.env`, compose files) from inside the container.
- Multi-replica / orchestrator (Swarm, k8s) support — compose single-container only; anything else degrades to the copy-paste quadrant.
- Changing the default compose security posture (socket stays opt-in, commented out).

## Decisions

### D1 — Full execution path, gated by runtime capability detection (not notify-only, not external updater)

The feature ships both halves: notification (works everywhere) and execution (works when the operator has mounted the socket and the tag is unpinned). Detection happens at runtime per-request, never at boot: if `/var/run/docker.sock` is absent, the Docker code path is simply never entered.

- _Alternative: notify-only + recommend Watchtower/Arcane._ Rejected by product decision — the goal is Arcane-parity from Rembric's own UI with no external tooling.
- _Alternative: require a `REMBRIC_SELF_UPDATE=on` flag in addition to the socket._ Rejected: mounting the socket is already an explicit, deliberate opt-in; a second flag adds a support-burden failure mode ("I mounted the socket, why no button?") without adding real security.

Capability state machine (computed server-side, drives the modal):

|                              | no socket                     | socket OK                                |
| ---------------------------- | ----------------------------- | ---------------------------------------- |
| **tag unpinned** (`:latest`) | `manual` — copy-paste command | `available` — one-click                  |
| **tag pinned** (`:0.21.1`)   | `manual` + unpin hint         | `pinned` — button disabled, explains why |

Plus `unavailable-perms` (socket mounted but EACCES — treated as `manual` with a log line and an in-modal hint about `group_add`) and `no-update` / `check-disabled`.

### D2 — Ephemeral upgrader container reusing the freshly pulled Rembric image

The swap is performed by a one-shot container started from the _new_ Rembric image with an alternate entrypoint (`node /app/dist/upgrade-helper.js`), socket mounted, parameterized with the old container id and target image. Sequence: inspect old → derive an identical create payload (Config/HostConfig/NetworkingConfig, labels included, image swapped) → stop old → rename old to `rembric-old-<ts>` → create + start new under the original name → poll the new container's `/healthz` → on success remove the old container; on failure stop/remove the new one, rename the old back, start it (rollback).

- _Alternative: orchestrate the swap from inside the running server._ Physically impossible — the orchestrating process dies at `stop`.
- _Alternative: use a third-party helper image (`docker:cli`, watchtower one-shot)._ Rejected: pulls a foreign image into the trust boundary; the new Rembric image is already present, already trusted, and already contains Node + our compiled code.
- Copying the `com.docker.compose.*` labels keeps compose recognizing the container as its own; with the tag at `latest` and the freshly pulled image being local-latest, a later `compose up -d` is a no-op (this is exactly why D3 refuses pinned tags).
- On success the upgrader removes the old container and itself; on failure the upgrader container is left in place (exited) so its logs are available for forensics.

### D3 — Refuse one-click on pinned tags; detect the pin from ground truth

If the running container was created from a version-pinned tag, one-click is disabled with an explanation ("your `.env` pins `REMBRIC_VERSION=0.21.1`; a later `compose up` would downgrade the update — unpin to enable one-click"). This _dissolves_ the compose-drift problem instead of mitigating it: a pinned deployment is never self-updated, so compose state and container state can never diverge.

Detection: when the socket is available, self-inspect and read `Config.Image`'s tag — ground truth. Fallback/cross-check: `process.env.REMBRIC_VERSION` (the compose pin reaches the container through `env_file`). Self-identification: container hostname (= short container id by default), falling back to the `rembric` container name.

- _Alternative: self-update anyway and tell the user to update `.env`._ Rejected: the failure mode (silent downgrade weeks later) is invisible exactly when the instruction has been forgotten.
- _Alternative: pin by digest after update._ Rejected: still diverges from the compose file's declared tag; more state to explain.

### D4 — Zero-dependency Docker Engine API client

A minimal client (`services/self-update/engine-api.ts`) over `node:http` with `socketPath` — the Engine API is plain JSON/HTTP. Needed calls: `GET /_ping`, `GET /containers/{id}/json`, `POST /images/create` (streamed pull progress), `POST /containers/create|start|stop|rename`, `DELETE /containers/{id}`. Versioned path prefix (e.g. `/v1.44`) pinned to a floor the feature requires.

- _Alternative: `dockerode`._ Rejected: large transitive surface for ~6 endpoints, against the repo's supply-chain posture (`minimumReleaseAge`, lockfile gates) for no capability we need.

### D5 — Update check: server-side, 24h in-memory cache, default-on with `REMBRIC_UPDATE_CHECK=off`

One `GET https://api.github.com/repos/susomejias/rembric/releases/latest` at most per 24h (lazy — triggered by dashboard visits, not a timer), ETag-aware, in-memory cache. Any failure (offline, rate-limited, air-gapped) silently yields "no update info"; no warnings, no retry storm. Semver compare against the running version; prereleases ignored. The release body (release-please generated, markdown with PR links) feeds the modal changelog.

- _Alternative: browser-side check against the GitHub API._ Rejected: leaks deployment metadata from every operator's browser, hits CORS/rate limits per viewer, and can't feed server-side capability state.
- _Alternative: opt-in check._ Rejected: defeats the purpose — the failure mode this feature fixes is operators who never opt into anything staying outdated silently. Opt-out + documented is the honest middle.
- _Alternative: persist cache in SQLite._ Rejected: a 24h-refetch after restart costs nothing; no reason to touch the schema.

### D6 — Pre-update backup is mandatory: `VACUUM INTO` under the data volume

Before launching the upgrader, the server runs `VACUUM INTO '/data/backups/pre-update-v<target>-<ts>.sqlite'` and aborts the update if it fails (including on insufficient disk). Retention: keep the 3 most recent `pre-update-*` files, deleting older ones after a successful backup. Rationale: migrations run on the new version's boot and are not reversible; the memory store is append-only and precious. This is Rembric's deliberate divergence from Arcane's flow (an extra "Backing up database" step in the progress UI).

- Coordination note: the in-flight `add-data-protection-defaults` change introduces general auto-snapshots; this backup is narrower (pre-update insurance) and intentionally independent. If both land, the implementations may share a snapshot helper but the pre-update gate stays non-skippable.

### D7 — Progress UX: polling, not SSE; reload by version probe

The dashboard is SSR + HTMX with no streaming infra; the update progress view polls a status endpoint (`GET /dashboard/update/status`) rendering the step list (check → backup → pull (with Engine-API progress) → restarting → verifying). Once the swap begins the server goes down mid-poll; the page treats connection errors as the "restarting" step and switches to probing a lightweight version endpoint until it answers with a version different from the one the page was rendered with, then reloads. Dashboard session cookies survive the restart because `dashboard_sessions` lives in SQLite on the persistent volume.

The version probe must be reachable during the auth dance after restart: reuse `/healthz`-style bearer-less exposure is NOT acceptable; instead the probe is a dashboard-session-authenticated endpoint returning `{ version }` — the session cookie survives, so no special unauthenticated surface is added.

Modal dismissal ("Later") is per-version in `localStorage`; the badge in the brand block persists regardless until updated.

### D8 — Dashboard integration follows existing conventions

Badge in the brand block next to the existing `v<version>` line (`components.ts`); modal and progress view in a new `dashboard/update.ts` using the locked design tokens (CSS in `dashboard/styles/`, no inline styles); the one-click trigger is a `<form>` with `data-confirm` and `data-confirm-tone="danger"`; timestamps ("published 2 days ago") via `formatTs`.

## Risks / Trade-offs

- **[Risk] Socket mount is root-equivalent on the host; a leaked admin token escalates from data access to host compromise.** → Strictly opt-in (commented compose line + docs), danger-tone confirmation, `docs/updates.md` states the trade-off plainly and recommends loopback/VPN binding when enabling, dashboard copy near the button names the risk.
- **[Risk] Upgrader dies mid-swap (host reboot, OOM) leaving the old container stopped/renamed and no new one running.** → Step order minimizes the window (create new before removing old); rollback path in the helper; `docs/updates.md` documents manual recovery (`docker rename` + `docker start`); the old container is only removed after the new one passes health-check.
- **[Risk] New version boots and passes `/healthz` but is functionally broken.** → Pre-update SQLite backup + previous image remains on disk; manual rollback documented (run old image, restore backup). MIT/no-warranty posture documented; one-click never auto-reruns.
- **[Risk] Failed new version migrates the DB forward before dying; the rolled-back old code can't boot against the newer schema.** → The upgrader health-checks the restored container after rollback and, on failure, logs the exact pre-update snapshot path (threaded via `REMBRIC_UPGRADE_BACKUP`) with restore instructions. DB restore is deliberately NOT automatic: the failed version's brief life may contain real writes (agent memories), and silently discarding them is data loss of the opposite kind — the operator decides. Documented in `docs/updates.md::Recovery`.
- **[Risk] GitHub anonymous rate limit (60 req/h/IP).** → ≤1 request/24h, ETag conditional requests, silent failure.
- **[Risk] Socket mounted but uid 10001 lacks permission (docker GID mismatch).** → Detected ping failure degrades to `manual` quadrant with a `group_add` hint; never an error.
- **[Risk] Disk exhaustion during pull or backup.** → Backup runs first and aborts the update on failure; pull errors surface in the progress view and leave the running container untouched (pull is side-effect-free until the swap).
- **[Trade-off] In-memory update-check cache refetches after every restart.** → Accepted: one cheap conditional GET; avoids schema changes.
- **[Trade-off] Polling instead of SSE for progress.** → Accepted: matches the HTMX/SSR architecture; 1–2s polls for under a minute is negligible.
- **[Trade-off] One-click unavailable on pinned tags even with the socket mounted.** → Accepted deliberately (D3); the alternative is silent-downgrade risk.

## Migration Plan

Nothing migrates. The feature is dormant-by-absence: existing deployments pull the new image and see only the badge/modal (notification quadrant). Enabling one-click is a one-time operator action (uncomment the socket line or add a `docker-compose.override.yml`, plus `group_add` where needed) — documented, never required. Rollback of the feature itself = run the previous image tag.

## Open Questions

- Backup retention count (default 3) — confirm against `add-data-protection-defaults` once that change lands to avoid two competing retention policies under `/data/backups/`.
- Engine API version floor: pick the oldest version that supports everything we call (likely `v1.41`+) and verify against Docker 20.10 as the practical minimum host.
