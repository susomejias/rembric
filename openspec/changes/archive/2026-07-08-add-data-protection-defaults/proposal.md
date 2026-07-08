## Why

Rembric is preparing to flip from private to public on GitHub. Today the entire data-protection story is "MIT no-warranty + `docs/backup.md` operator-must-do-this" — operators get zero default safety net beyond the legal floor, and the recovery path lives in docs no one reads until after the loss. The owner has explicitly stated they will not accept responsibility for operator data loss, and wants that stance to be both visible AND operationally cheap to comply with. SQLite makes this almost free: the entire state is one portable file, and `VACUUM INTO` produces atomic, WAL-safe single-file snapshots without stopping the server.

## What Changes

- **NEW** `src/backup/scheduler.ts` — background worker that runs `VACUUM INTO '<data-dir>/backups/data-<ISO>.db'` every 6 hours (env-tunable) and rotates keep-last-7. Default ON. Wired in `src/server/bootstrap.ts` alongside the consolidation scheduler.
- **NEW** pre-migration snapshot hook — before any drizzle migration applies on boot, write a snapshot named `pre-migration-<schema-version>.db` to the same directory. Out-of-band from the regular rotation (these are kept indefinitely until the operator deletes them).
- **NEW** env vars: `REMBRIC_BACKUP_INTERVAL_MS` (default `21_600_000`), `REMBRIC_BACKUP_KEEP` (default `7`), `REMBRIC_BACKUP_DISABLE` (default `false`).
- **EXTEND** `consolidation_ops.op_type` Drizzle enum union with `'backup_snapshot'`. Pure TS-level union widen — no DB migration needed (column is `TEXT`). Each snapshot writes one journal row in the same transaction as the file produced.
- **NEW** `/dashboard/maintenance` "SNAPSHOTS" panel above the existing purge panels:
  - Table of recent snapshots: timestamp · size · trigger (`auto` / `manual` / `pre-migration`) · download link.
  - `[SNAPSHOT NOW]` button — CSRF-protected POST → synchronous snapshot → htmx swap.
  - `[RESTORE FROM SNAPSHOT]` button per row — CSRF-protected POST gated by `data-confirm` modal (tone `warn`). Restore renames the snapshot over `data.db`, writes a `restart_required` flag file, and the modal copy makes the restart requirement explicit. **No hot-swap** — out of scope, too easy to get wrong.
  - Download endpoint streams the `.db` with `Content-Disposition: attachment`.
- **NEW** invariant tests pinning: (1) `VACUUM INTO` target paths MUST be under `<data-dir>/backups/`, (2) ONLY `src/backup/*` and `src/dashboard/maintenance.ts` may invoke `VACUUM INTO`, (3) `consolidation_ops` row for a snapshot MUST be written in the same transaction as the file produced (no orphan files / orphan journal entries).
- **REFRESHED** `docs/backup.md` — opens with the disclaimer, adds Docker-aware recipes (bind-mount is `./data/`), adds end-to-end restore recipe, positions litestream as the operator-escalation path (no shipped integration).
- **NEW** `README.md` section "Data and your responsibility" near install/quickstart with the disclaimer copy + link to `docs/backup.md` + summary of the shipped defaults.
- **DEFERRED** to a follow-up change: MCP tool `memory.snapshot_now` (agents triggering snapshots before bulk ops). Not in this change to keep plugin manifests untouched.

Not in scope: litestream shipped integration; HA / multi-instance backup merging; encrypted-at-rest snapshots (the backup directory inherits the bind-mount's filesystem permissions — operator concern).

## Capabilities

### New Capabilities

None. This change extends two existing capabilities.

### Modified Capabilities

- `persistence`: ADD requirements for auto-backup default-on behavior (interval, rotation, disable env, target path constraint) and pre-migration snapshot hook; ADD requirement for `backup_snapshot` journaling in `consolidation_ops`.
- `dashboard`: ADD requirement for the `/dashboard/maintenance` SNAPSHOTS panel covering list, manual snapshot trigger, download, and restore-with-restart.

## Impact

**Code**

- New: `src/backup/scheduler.ts`, `src/backup/scheduler.test.ts`, `src/backup/storage.ts` (file IO + rotation), `src/backup/storage.test.ts`.
- Modified: `src/server/bootstrap.ts` (wire scheduler, wire pre-migration hook), `src/db/schema/consolidation.ts` (enum widen), `src/dashboard/maintenance.ts` (new panel), `src/dashboard/styles/views/maintenance.css` (new section styles), `src/server/dashboard-router.ts` (new routes), `src/test/invariants.test.ts` (new pins).
- Docs: `README.md` (new section + link), `docs/backup.md` (refresh).

**Runtime / footprint**

- Disk: with default `<50 MB` DB × 7 rotated + N pre-migration snapshots ≈ <350 MB + per-migration overhead in `<data-dir>/backups/`. Lives inside the same Docker bind-mount the operator already manages.
- CPU: `VACUUM INTO` runs every 6h, takes seconds on a `<50 MB` DB. Negligible.
- Memory: scheduler is `setInterval`-based, no state beyond the timer handle.

**Surfaces unchanged**

- MCP tool surface (deferred follow-up).
- Plugin manifests (`plugin/.claude-plugin/`, `plugin/.codex-plugin/`, `plugin/.hermes-plugin/`) — no version bump.
- Scope resolution, append-only invariant, scope-in-service contract — all orthogonal.
- DB schema (no migration; the `op_type` widen is TS-only because Drizzle's enum is a type-level constraint over a `TEXT` column).

**Versioning**

- Server: minor bump (new env vars + new dashboard surface, no breaking changes).
- Plugins: no bump (no plugin-facing change).

**Operator-visible changes on first boot after upgrade**

- A new `backups/` directory appears inside `$REMBRIC_DATA_DIR` (or `./data/` under Docker). Documented in the migration note section of the release.
- A pre-migration snapshot is written on the first boot after upgrade (since migration `0002 → latest` runs). Helps cover the upgrade itself.
