# Proposal: self-update-image-retention

## Why

Every one-click self-update pulls a new image but never reclaims the previous one, and Docker never garbage-collects images on its own — so each update leaks ~1.4GB. A production host accumulated ~40 dangling `<none>` images (~56GB, root filesystem at 96%) after two months of updates, while the actual data was under 100MB. The updater already prunes its DB backups (`BACKUP_KEEP = 3`) but has no equivalent policy for images or stale upgrader containers (GitHub issue #282).

## What Changes

- The update flow gains a best-effort cleanup step in the orchestrator, after a successful pull and before launching the upgrader:
  1. Remove stale upgrader containers (label `rembric.upgrader=1`, state `created` or `exited`) left behind by previous updates.
  2. Prune dangling images scoped to Rembric via the `rembric.stage=runtime` image label (`POST /images/prune` with `dangling=true` + `label` filters).
- Cleanup failures are logged and never abort the update.
- Rollback is preserved with zero bookkeeping via Docker's container-pinning semantics: at prune time the running container still pins the current image, so the immediately-previous image always survives one update cycle (stateless keep-1). Operator-pinned tagged images (e.g. `0.21.1`) are never dangling, hence never pruned.
- The rollback logic in `upgrade-helper.ts` is untouched.
- `docs/updates.md` documents the automatic retention and keeps `docker image prune -a` as the manual fallback for hosts that accumulated images before this change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `self-update`: adds a requirement that a successful update path MUST reclaim stale update artifacts (dangling Rembric images and finished upgrader containers) while always preserving the immediately-previous image for rollback, best-effort and never blocking the update.

## Impact

- `apps/server/src/services/self-update/engine-api.ts` — two new thin Engine API wrappers: `listContainers(filters)` and `pruneImages(filters)` (same zero-dependency `node:http`-over-socket pattern; self-update remains contractually dependency-free).
- `apps/server/src/services/self-update/orchestrator.ts` — one cleanup call post-pull/pre-handoff, try/catch + log.
- `apps/server/src/services/self-update/engine-api.test.ts` and orchestrator tests — coverage for the wrappers, cleanup ordering, failure tolerance, and the never-remove-a-running-upgrader guard.
- `docs/updates.md` — retention behavior + manual fallback note.
- No compose changes, no new dependencies, no changes to `upgrade-helper.ts` or its rollback paths, no schema/DB impact. Append-only memory, scope-at-service, and other durable invariants are not touched.
