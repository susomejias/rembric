# self-update — delta for self-update-image-retention

## ADDED Requirements

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
