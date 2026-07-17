# self-update Specification

## Purpose

Defines how Rembric detects new releases and updates its own container from the dashboard: the daily GitHub Releases check (default-on, opt-out, silent failure), runtime capability detection over the Docker socket (`available` / `pinned` / `manual`), the one-click execution path (mandatory pre-update SQLite backup, ephemeral upgrader container, health-check, rollback with post-rollback verification), the zero-action compatibility guarantee for deployments that change nothing, and the operator documentation contract (compose opt-in, docs, README).

## Requirements

### Requirement: The server MUST check for new releases at most once per 24 hours, default-on with an opt-out

The server SHALL determine the latest published release of Rembric by querying the GitHub Releases API for the distribution repository, automatically at most once per 24-hour window, lazily (triggered by dashboard activity, not a timer), using conditional requests (ETag) where possible. The result SHALL be cached in memory together with the release changelog body. Setting `REMBRIC_UPDATE_CHECK=off` SHALL disable the check entirely. Any failure of the automatic check (network unreachable, rate-limited, malformed response) SHALL be silent: no error logs above debug level, no dashboard warnings, and all other functionality unaffected. Prerelease versions SHALL be ignored.

The 24-hour cadence bounds the automatic path only; an operator-initiated manual check (see the manual-check requirement) MAY run at any time and SHALL reset the window.

#### Scenario: New version detected

- **WHEN** the running version is `0.21.1` and the GitHub Releases API reports latest release `server-v0.22.0`
- **THEN** the server SHALL expose update availability (current version, latest version, publication date, changelog body) to the dashboard layer

#### Scenario: Check disabled by operator

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set
- **THEN** the server SHALL NOT contact the GitHub API and the dashboard SHALL render with no update badge or modal

#### Scenario: Air-gapped host

- **WHEN** the GitHub API is unreachable
- **THEN** the server SHALL behave as if no update is available, without surfacing errors or warnings to the operator

### Requirement: An operator MUST be able to force an immediate release check that reports its outcome

The server SHALL expose an operator-initiated manual check that performs the release query immediately, bypassing the 24-hour window, while reusing the conditional-request (ETag) cache and deduplicating against any in-flight check. Unlike the automatic path, the manual check SHALL report its outcome to the caller as one of: a newer version was found, no newer version is known, or the check failed to reach the GitHub API. The manual check SHALL be unavailable when `REMBRIC_UPDATE_CHECK=off`. The server SHALL expose the timestamp of the most recent check (manual or automatic) within the current process lifetime.

#### Scenario: Manual check finds a new release

- **WHEN** an operator triggers a manual check and the GitHub Releases API reports a release newer than the running version
- **THEN** the check SHALL report the update outcome and the cached update availability SHALL reflect the new release immediately

#### Scenario: Manual check on an up-to-date deployment

- **WHEN** an operator triggers a manual check and no newer release exists
- **THEN** the check SHALL report that no newer version is known, without claiming more than the API returned

#### Scenario: Manual check cannot reach GitHub

- **WHEN** an operator triggers a manual check and the GitHub API is unreachable or returns an error
- **THEN** the check SHALL report the failure outcome to the operator (distinct from "no newer version") while the automatic path's silent-failure behavior remains unchanged

#### Scenario: Manual check while disabled

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set
- **THEN** the manual check SHALL NOT contact the GitHub API and SHALL NOT be offered in the dashboard

### Requirement: Self-update capability MUST be detected at runtime and never assumed

The server SHALL compute a self-update capability state on demand, without any boot-time dependency on Docker. The state SHALL be one of:

- `available` — `/var/run/docker.sock` exists, the Engine API responds to a ping, and the running container's image tag is not pinned to a specific version
- `pinned` — socket usable, but the running container was created from a version-pinned image tag
- `manual` — no socket, or the socket exists but is not usable (e.g. permission denied)

Tag-pin detection SHALL use the running container's actual image reference obtained by self-inspection over the Engine API (container hostname as id, `rembric` container name as fallback) as ground truth, with the `REMBRIC_VERSION` environment variable as a secondary signal when inspection is unavailable. A socket that exists but fails the ping SHALL degrade to `manual` with at most a single informational log line.

#### Scenario: Socket mounted, tag unpinned

- **WHEN** the Docker socket is mounted and usable and the container runs image tag `latest`
- **THEN** the capability state SHALL be `available`

#### Scenario: Socket mounted, tag pinned

- **WHEN** the Docker socket is mounted and usable and the container runs image tag `0.21.1`
- **THEN** the capability state SHALL be `pinned`

#### Scenario: Socket mounted without permissions

- **WHEN** the Docker socket is mounted but the server's uid cannot connect to it
- **THEN** the capability state SHALL be `manual` and the server SHALL NOT raise errors or repeat warnings

### Requirement: Deployments without the Docker socket MUST keep working with zero action (zero-action compatibility)

A deployment that updates the image with `docker compose pull && docker compose up -d` and changes nothing else SHALL boot and operate identically to the previous version: no new configuration required, no new errors or warnings at boot or during operation, `/healthz` unaffected, MCP and dashboard surfaces unaffected, and the self-update feature present only in its degraded `manual` form (notification + copy-paste command).

#### Scenario: Existing compose file, new image, no socket

- **WHEN** a container built from this version starts with a compose file that predates this feature (no socket mount)
- **THEN** the server SHALL start cleanly, log no new warnings, serve all existing functionality, and report capability `manual`

### Requirement: One-click self-update MUST be executed by an ephemeral upgrader container with health-check and rollback

When the capability state is `available` and the operator confirms the update, the server SHALL execute, in order: (1) pre-update database backup (see backup requirement) — abort on failure; (2) pull the target image via the Engine API, surfacing pull progress; (3) create and start a one-shot upgrader container from the freshly pulled image with an alternate entrypoint, with the Docker socket mounted, parameterized with the current container's id and the target image.

The upgrader SHALL: inspect the old container and derive a creation payload preserving its configuration (ports, volumes, environment, labels — including compose labels — restart policy, network settings) with only the image changed; stop the old container; rename it out of the way; create and start the replacement under the original name; poll the replacement's health endpoint until healthy or a bounded timeout. On success the upgrader SHALL remove the old container and itself. On failure the upgrader SHALL stop and remove the replacement, restore the old container's name, restart it, and leave itself (exited) for log inspection.

The update SHALL only proceed for the Rembric container itself; the feature SHALL NOT manage any other container.

#### Scenario: Successful update

- **WHEN** the operator confirms a one-click update from `0.21.1` to `0.22.0`
- **THEN** the system SHALL back up the database, pull the new image, swap the container preserving its configuration, verify health, remove the old container, and the dashboard SHALL come back on `0.22.0` with data intact

#### Scenario: Replacement fails health check

- **WHEN** the replacement container does not become healthy within the timeout
- **THEN** the upgrader SHALL remove the replacement, restore and restart the old container under its original name, and the deployment SHALL be back on the previous version

#### Scenario: Pull fails

- **WHEN** the image pull fails (network, disk)
- **THEN** the running container SHALL be untouched and the failure SHALL be reported in the update progress view

#### Scenario: Old version fails to recover after rollback

- **WHEN** the rollback restarts the previous container but it does not become healthy (e.g. the failed release migrated the database schema forward)
- **THEN** the upgrader SHALL log that the database may have been migrated forward and SHALL name the pre-update snapshot path with restore instructions; the database SHALL NOT be restored automatically (writes accepted during the failed update's lifetime must never be silently discarded)

### Requirement: A database backup MUST be taken before any container swap and MUST gate the update

Before launching the upgrader, the server SHALL produce a consistent SQLite snapshot via `VACUUM INTO` to a timestamped file under the data volume (e.g. `/data/backups/pre-update-v<target>-<ts>.sqlite`). If the backup fails for any reason, the update SHALL be aborted before any container is stopped. After a successful backup, the server SHALL retain at most the 3 most recent pre-update backup files, removing older ones.

#### Scenario: Backup failure aborts update

- **WHEN** the pre-update `VACUUM INTO` fails (e.g. insufficient disk)
- **THEN** the update SHALL abort with the running container untouched and the failure reason shown to the operator

#### Scenario: Retention

- **WHEN** a fourth pre-update backup completes successfully
- **THEN** the oldest pre-update backup file SHALL be removed

### Requirement: One-click update MUST be refused when the image tag is pinned

When the capability state is `pinned`, the server SHALL refuse to execute a one-click update and the dashboard SHALL explain that the deployment pins the image tag (e.g. via `REMBRIC_VERSION` in `.env`), that self-updating would be silently reverted by a later `docker compose up`, and how to unpin to enable one-click.

#### Scenario: Pinned deployment requests update

- **WHEN** the capability state is `pinned` and an update-trigger request reaches the server
- **THEN** the server SHALL reject it without side effects and the UI SHALL show the pinned-tag explanation instead of an update button

### Requirement: The self-update implementation MUST NOT add runtime npm dependencies

All Docker Engine API interaction SHALL be implemented with Node built-ins (`node:http` over the unix socket). The feature SHALL NOT introduce new entries in `apps/server/package.json` `dependencies`.

#### Scenario: Dependency audit

- **WHEN** the feature is fully implemented
- **THEN** `apps/server/package.json` SHALL contain no new runtime dependencies attributable to it

### Requirement: The socket opt-in and update behavior MUST be documented in compose, docs, and README

`docker-compose.yml` SHALL include the Docker socket mount as a commented-out line with a pointer to the documentation. A `docs/updates.md` page SHALL document: the zero-action notification behavior, how to enable one-click (uncomment or `docker-compose.override.yml`, plus `group_add` guidance), the explicit statement that mounting the socket is root-equivalent on the host, the pinned-tag behavior, the pre-update backup location, and manual recovery steps if an update is interrupted. `README.md` SHALL list the auto-updater from the UI as a feature and link to `docs/updates.md`.

#### Scenario: New install reads compose

- **WHEN** a new operator opens the shipped `docker-compose.yml`
- **THEN** the socket mount SHALL be present but commented out, with a comment referencing the security trade-off and the docs page

#### Scenario: README feature entry

- **WHEN** a visitor reads the README features
- **THEN** the UI auto-updater SHALL be listed and SHALL link to `docs/updates.md`

### Requirement: The update flow MUST reclaim stale update artifacts without ever compromising rollback

After the pre-update backup succeeds and before the target image is pulled, the orchestrator MUST perform a best-effort cleanup of artifacts left behind by previous updates. Cleanup runs before the pull because the pull is the step that fails with ENOSPC on a disk-full host — sequenced after it, the reclaim would be unreachable exactly when it is most needed:

1. Remove upgrader containers labeled `rembric.upgrader=1` in `created` or `exited` state. Running upgrader containers MUST never be removed.
2. Prune dangling images scoped to Rembric via the `rembric.stage=runtime` image label, using the Docker Engine prune endpoint with `dangling=true` and `label` filters.

Cleanup MUST be best-effort: any cleanup failure is logged and MUST NOT abort or delay the update. Cleanup MUST NOT touch images or containers belonging to other services on the host, and MUST NOT remove tagged images (an operator-pinned version tag is never dangling). Every prune call MUST be scoped by a Rembric-owned label; the Engine API client MUST refuse — before any socket I/O — a prune request whose filters lack a non-empty `label` entry, so an unscoped prune (which would remove every stopped container or every dangling image on a shared host) is structurally impossible. Because cleanup runs while the current container is still running — and Docker never prunes an image referenced by an existing container — the immediately-previous image always survives one update cycle, preserving local rollback with no retention bookkeeping.

#### Scenario: Stale images from older updates are reclaimed

- **WHEN** an update to vN starts on a host that has dangling Rembric runtime images left over from updates older than the currently-running vN-1
- **THEN** before the pull begins, those older dangling images are pruned, while the vN-1 image (pinned by the running container) and any explicitly tagged image survive

#### Scenario: Disk-full host can still update

- **WHEN** an update starts on a host whose disk is nearly full with stale Rembric images, such that the image pull would fail with ENOSPC
- **THEN** the reclaim step frees that space before the pull runs, instead of the update aborting with the cleanup unreachable

#### Scenario: Previous image survives for rollback

- **WHEN** the update to vN completes successfully and the old container is removed
- **THEN** the vN-1 image remains on the host (now dangling but unpinned) until the next update's cleanup pass, so a manual rollback to vN-1 needs no registry access

#### Scenario: Stale upgrader containers are swept

- **WHEN** an update starts on a host with `rembric-upgrader-*` containers in `created` or `exited` state left by earlier failed or interrupted updates
- **THEN** those containers are removed before the new upgrader is launched, unpinning the images they held; a `running` upgrader container is left alone

#### Scenario: Cleanup failure never blocks the update

- **WHEN** the container sweep or the image prune fails (e.g. a 409 from a concurrent prune on the host)
- **THEN** the failure is logged, the other cleanup step still runs (they fail independently), and the update proceeds exactly as it would have without the cleanup step

#### Scenario: Other services on the host are untouched

- **WHEN** the host runs unrelated containers (running or stopped) whose images are dangling
- **THEN** the prune (filtered by the `rembric.stage=runtime` label) does not remove them, and the container sweep (filtered by the `rembric.upgrader=1` label) does not remove their containers

#### Scenario: Unscoped prune is refused before reaching the daemon

- **WHEN** a prune is attempted with filters missing a non-empty `label` entry
- **THEN** the Engine API client throws before performing any socket I/O and nothing on the host is affected
