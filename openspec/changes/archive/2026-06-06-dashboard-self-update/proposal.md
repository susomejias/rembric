# Proposal: dashboard-self-update

## Why

Operators have no way to learn a new Rembric version exists short of watching the GitHub repo, and updating requires manual `docker compose pull` on the host. Tools like Arcane have set the expectation for self-hosted apps: the dashboard tells you a release is out, shows the changelog, and — when the operator has granted Docker access — performs the stop/pull/recreate cycle itself with one click. Rembric already surfaces its running version in the dashboard brand; this change closes the loop from "version shown" to "version managed".

## What Changes

- New server-side **update check**: fetch the latest GitHub Release for `susomejias/rembric` at most once per 24h, compare against the running `REMBRIC_VERSION`, cache in memory. Disabled with `REMBRIC_UPDATE_CHECK=off`. Failure is silent (air-gapped hosts keep working with no badge and no warnings).
- New **dashboard update surface**: badge next to the version in the brand block, a dismissable per-version modal with the release changelog, and an update progress view (pull → backup → restart → verify → reload via browser polling).
- New **one-click self-update execution**, available only when BOTH hold: `/var/run/docker.sock` is mounted into the container AND the running container's image tag is not pinned to a specific version. Implementation: a zero-dependency Docker Engine API client over the unix socket (`node:http` `socketPath`), plus an ephemeral upgrader container started from the freshly pulled image with an alternate entrypoint (`upgrade-helper`) that stops/renames the old container, recreates it with identical config and the new image, health-checks it, and rolls back on failure.
- New **pre-update SQLite backup**: `VACUUM INTO` a timestamped file under the data volume before any container swap. Non-skippable.
- **Graceful capability degradation** (the four-quadrant contract):
  - no socket → modal shows the copy-paste `docker compose pull && docker compose up -d` command and the docs link for enabling one-click;
  - socket present but image tag pinned (e.g. `.env` sets `REMBRIC_VERSION=0.21.1`) → modal explains one-click is disabled because a later `compose up` would silently downgrade, and shows how to unpin;
  - socket present, unpinned tag → one-click button behind a danger-tone confirmation;
  - update check off/unreachable → no badge, everything else identical.
- **Zero-action compatibility** (hard acceptance criterion): an existing deployment that only runs `docker compose pull && docker compose up -d` MUST boot and operate with no config change, no new errors or warnings, self-update in `unavailable` state, and every other feature intact.
- `docker-compose.yml` gains a **commented** socket-mount line (affects new installs only; existing compose files are untouched by image updates by nature).
- Documentation: new `docs/updates.md` (enabling one-click, the socket security trade-off, pinned-tag behavior) and a README feature entry ("auto-updater from the UI") linking to it.

No DB schema changes, no new npm dependencies, no changes to MCP tools or memory semantics. Append-only memory, scope-at-service, and topic_key invariants are untouched.

## Capabilities

### New Capabilities

- `self-update`: version-update detection (GitHub Releases poll, opt-out, silent failure), capability detection (socket presence, tag-pin detection via self-inspect with env fallback), one-click update execution (Engine API client, ephemeral upgrader container, pre-update SQLite backup, health-check + rollback), zero-action compatibility for socket-less deployments, and the operator documentation/compose opt-in contract.

### Modified Capabilities

- `dashboard`: new requirements for the update badge in the brand block, the per-version dismissable update modal with changelog, the update progress view with post-restart polling/reload, and the danger-tone confirmation on the one-click action.

## Impact

- **New code** (all under `apps/server/src/`):
  - `services/update-check.ts` — release poll, semver compare, 24h in-memory cache, `REMBRIC_UPDATE_CHECK` gate.
  - `services/self-update/engine-api.ts` — minimal Docker Engine API client over the unix socket (ping, inspect, image pull with progress, container create/start/stop/rename/remove).
  - `services/self-update/capability.ts` — socket detection, self-container resolution (hostname → inspect, `container_name` fallback), tag-pin detection, four-quadrant state.
  - `services/self-update/orchestrator.ts` — update state machine driven by the dashboard (pull → backup → launch helper), status exposed for polling.
  - `scripts/upgrade-helper.ts` — compiled to `dist/`; entrypoint of the ephemeral upgrader container (swap + health-check + rollback).
- **Modified code**:
  - `apps/server/src/server/dashboard-router.ts` — update endpoints (trigger, status poll, unauthenticated-safe version probe for post-restart reload) and badge data.
  - `apps/server/src/dashboard/components.ts` — brand badge; new `apps/server/src/dashboard/update.ts` view; styles under `apps/server/src/dashboard/styles/`.
- **Deployment/docs**: `docker-compose.yml` (commented opt-in line), `docs/updates.md` (new), `README.md` (feature section + link).
- **Tests**: unit tests for update-check/capability/orchestrator/helper against a mocked Engine API; dashboard e2e for the four quadrants; explicit zero-action regression (boot without socket → healthz OK, dashboard OK, no new warnings). Invariant tests unaffected.
- **Security posture**: unchanged by default. Mounting the Docker socket is root-equivalent on the host and is strictly opt-in; the docs and the in-dashboard copy must state this plainly.
