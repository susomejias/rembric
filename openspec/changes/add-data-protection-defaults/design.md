## Context

Rembric ships as a single Node process backing one SQLite file. The full state of every project lives in `$REMBRIC_DATA_DIR/data.db` (plus its transient WAL/SHM sidecars). Today the only protection against operator data loss is:

1. The MIT license's "AS IS" clause (legal floor, invisible to most readers).
2. `docs/backup.md` — recipes for `sqlite3 .backup` + cron, manual snapshots, or litestream. All operator-initiated, none default-on.
3. The append-only invariant on `memory` and `sessions`, which protects against semantic corruption but not against file loss, container destruction, or operator error.

The project is preparing for public open-source release. The owner has explicitly:

- Disclaimed any responsibility for data loss in operator deployments.
- Requested a default-on backup system that leverages SQLite's portability so the recovery bar stays low.

Existing infrastructure we can lean on:

- `src/consolidation/scheduler.ts` — `setInterval`-based background worker pattern, started from `src/server/bootstrap.ts`. Exact shape we want to mirror.
- `src/services/agent-sessions.ts::purgeEmpty` and `src/services/memory.ts::purgeDisconnectedArchived` — precedent for journaled physical operations against the DB, with `consolidation_ops` rows written in the same transaction.
- `/dashboard/maintenance` (`src/dashboard/maintenance.ts`) — existing admin-gated dashboard surface with the `data-confirm` modal pattern. Natural home for the SNAPSHOTS panel.
- `src/test/invariants.test.ts` — file-allow-list pattern that pins which files are allowed to emit certain operations. We extend it for `VACUUM INTO`.

SQLite-specific levers:

- `VACUUM INTO '<path>'` produces a single-file copy without WAL/SHM sidecars, works under WAL mode, and is atomic from the writer's perspective. Defragments as a bonus.
- `sqlite3_backup_*` API (exposed via `better-sqlite3.backup()`) is the alternative — streams pages and supports incremental progress. Slightly more complex; produces a file that can have a WAL sidecar at the destination depending on settings.

## Goals / Non-Goals

**Goals:**

- Default-on automatic snapshots without any operator configuration. Disk footprint stays bounded by a `KEEP` rotation.
- Pre-migration snapshot before any drizzle migration applies. Highest-value moment to have a backup — schema bugs in releases are the failure mode where an operator most wants a known-good copy.
- Manual snapshot trigger from the dashboard for "I'm about to do something risky" workflows.
- Operator-visible restore path with explicit "this requires a process restart" semantics — no silent magic.
- Disclaimer visible BEFORE the operator hits a problem. README section, not just LICENSE.
- Reuse the existing `consolidation_ops` journaling table so every snapshot is auditable from the same surface where the operator already inspects ops.
- Keep the backup directory inside the existing data volume (`<data-dir>/backups/`) so Docker bind-mount users get backups portable across host restarts without extra config.

**Non-Goals:**

- Hot-swap restore (close DB handle, swap file, re-open) — too easy to corrupt in-flight transactions, prepared statements, FTS triggers. Restart is honest and simple.
- Litestream shipped integration — kept as the documented escalation path for operators who need seconds-level RPO.
- Cloud-target backups (S3 / GCS) — operator concern; the local backup directory can be picked up by any sync tool they already run.
- HA / multi-instance backup merging — the project is single-process by design.
- Encrypted-at-rest snapshots — `.db` files inherit filesystem permissions; operator's concern.
- MCP tool `memory.snapshot_now` — deferred to follow-up to keep plugin manifests untouched in this change.
- Pre-purge snapshots tied to `purgeEmpty` / `purgeDisconnectedArchived` — could be added later, but the maintenance page already gates those with `data-confirm` modals, and a manual snapshot is one click away.

## Decisions

### Decision 1 — Use `VACUUM INTO`, not `sqlite3_backup_*`

`db.exec("VACUUM INTO '<path>'")` produces a single-file output that's safe to copy / move / restore by simple file rename. No WAL/SHM siblings at the destination. Works under WAL mode at the source. Atomic to outside observers: the file appears at its final path or not at all.

`better-sqlite3.backup(destPath)` is a viable alternative — page-streamed, supports progress events. But the destination file can produce its own WAL/SHM under load, complicating "what files do I copy to back up the backup" semantics.

**Trade-off accepted:** `VACUUM INTO` rewrites every page (it's a full vacuum), so on a 50 MB DB it takes a couple of seconds. With a default 6-hour cadence this is invisible. If the project later needs sub-second snapshots, swap implementations behind the same `BackupStorage` interface.

**Alternatives considered:**

- `cp data.db data.db.bak` while running — corrupts under concurrent writes (WAL pages not yet checkpointed). Hard no.
- `sqlite3 .backup` CLI shelled out — adds a process dependency (the system `sqlite3` CLI), defeats the "single-binary" posture.
- Filesystem snapshot (LVM, btrfs) — requires operator infrastructure we can't assume.

### Decision 2 — Default-on, env-tunable, opt-out

Three env vars in order of decreasing likelihood of operator override:

```
REMBRIC_BACKUP_INTERVAL_MS   default 21_600_000  (6h)
REMBRIC_BACKUP_KEEP          default 7
REMBRIC_BACKUP_DISABLE       default false
```

Rationale for default-on: the entire point of this change is to protect operators who didn't read `docs/backup.md`. Default-off would only help the operators who already would have configured backups manually, which is the opposite of who needs the help.

Rationale for "DISABLE" instead of "ENABLE": communicates "this is on, you have to actively turn it off." Reduces silent footguns where someone sets `REMBRIC_BACKUP_ENABLE=false` thinking "false means use the default" and ends up with no backups.

**Footprint sanity check:** `<50 MB × 7 = ~350 MB` for the rotation, plus N pre-migration snapshots (typically 1-5 across the lifetime of an install). Acceptable inside the existing data volume.

### Decision 3 — Journal each snapshot in `consolidation_ops` with a new `op_type`

The `consolidation_ops` table already journals every physical-purge op. Snapshots are physical ops too — they produce a file outside the DB. Reusing the table gives us:

- One audit surface for "what physical operations happened against this install?"
- Same backup/restore semantics (the journal is in the DB; the snapshot files are in `<data-dir>/backups/`; both move together if the operator backs up the data directory).
- Existing dashboard surface (`/dashboard/consolidation`) can later be extended to render snapshot rows alongside purges if desired.

Schema change: extend the Drizzle enum union for `op_type` to include `'backup_snapshot'`. The underlying column is `TEXT` with no CHECK constraint — this is a TS-level widen, no DB migration needed.

**Row shape:**

```
op_type        : 'backup_snapshot'
op_id          : ULID
created_at     : ISO timestamp
affected_ids   : [] (empty — backup affects no memory rows)
created_id     : null
metadata       : { trigger: 'auto'|'manual'|'pre-migration', file_path, bytes, schema_version }
```

The `metadata` JSON field is already used by other op_types for op-specific data.

**Atomicity contract:** the file write and the journal row MUST be in the same `better-sqlite3` transaction. If the file write fails, no journal row. If the journal write fails, the file is unlinked. Invariant pinned in `src/test/invariants.test.ts`.

### Decision 4 — Restore requires explicit process restart, no hot-swap

The restore handler:

1. Verifies the source snapshot exists and is under `<data-dir>/backups/`.
2. Renames `<data-dir>/data.db` to `<data-dir>/data.db.pre-restore-<ISO>`.
3. Copies the snapshot to `<data-dir>/data.db`.
4. Writes `<data-dir>/restart_required` flag file.
5. Returns 200 with a body that explicitly tells the operator to restart.

The dashboard modal copy says (data-confirm):

> Replace the live database with snapshot `<file>`? The server will continue running with the OLD database until restarted. **Operator action required: restart the rembric process / container after this completes.** Reversible by restoring the auto-saved `data.db.pre-restore-*` copy.

**Why not hot-swap:**

- `better-sqlite3` holds a stable handle; replacing the file under it produces undefined behaviour (the handle keeps pointing at the inode, not the path).
- FTS triggers, prepared statements, and the migration runner all assume schema continuity.
- Hot-swap would require draining in-flight requests, closing the handle, re-opening — that's a graceful-shutdown ceremony for a corner-case operation. Restart achieves the same with the existing supervisor / Docker restart policy doing the work.

**Why a `restart_required` flag file:**

- An external supervisor (Docker `restart: unless-stopped`) won't know to restart based on an HTTP response. The flag file is read on next boot and surfaced in the startup banner; if the operator never restarted, they see "Note: a restore was performed but the process never restarted to pick it up" on the next start.

### Decision 5 — Pre-migration snapshots are out-of-band from the rotation

Regular auto-snapshots and manual snapshots compete for `REMBRIC_BACKUP_KEEP` slots. Pre-migration snapshots have a distinct lifecycle: they protect a specific schema transition and are typically valuable for a long time after that transition completes. They're kept indefinitely, named `pre-migration-<schema-version>-<ISO>.db`, and the operator decides when to delete them from the dashboard (or by hand).

**Trade-off accepted:** unbounded growth of pre-migration snapshots. Mitigation: schema migrations are rare events (the project has had <10 over its lifetime so far). Operator-visible in the snapshots table with the `pre-migration` trigger column, so they can be cleaned up explicitly.

### Decision 6 — Disclaimer copy goes in README, not LICENSE

The MIT license already contains "AS IS, no warranty." Adding an explicit README section makes the project's posture visible at the same scroll position where someone evaluates whether to adopt Rembric. The disclaimer also serves as the natural place to point at `docs/backup.md` and the default-on guarantee.

The README section title is "Data and your responsibility" (matches the brutalist, direct tone of the rest of the README).

## Risks / Trade-offs

- **[Risk] `VACUUM INTO` takes seconds, blocks writers briefly** → Mitigation: 6h cadence makes this invisible; manual snapshot is operator-initiated so they accept the latency.
- **[Risk] Backup directory disk fills if operator forgets pre-migration snapshots** → Mitigation: dashboard table lists every snapshot with size; operator can delete with one click; pre-migration count is bounded by schema-migration count which is small.
- **[Risk] Restore writes a different schema version than the running migration version** → Mitigation: pre-migration snapshots are tagged with `schema_version` in metadata; the dashboard restore confirm modal shows the schema version of the snapshot and warns if it differs from current.
- **[Risk] Snapshot file in `<data-dir>/backups/` is world-readable if operator's filesystem permissions are loose** → Mitigation: scheduler `chmod`s the backups directory to 0700 on create (mirrors existing data directory creation in `bootstrap.ts`). Documented in `docs/backup.md`.
- **[Risk] Operator disables backups via env, forgets, loses data** → Accepted. The disclaimer + dashboard surface + non-empty backups directory by default makes the path of least resistance "backups exist." Operators who actively turn them off have made an informed choice.
- **[Trade-off] One file per snapshot, not page-incremental** → `VACUUM INTO` rewrites everything. Doesn't matter at <50 MB; would matter at >1 GB. Re-evaluate when that becomes a real constraint.
- **[Trade-off] Backup directory inside data volume** → On Docker, this means backups die with the volume. Mitigated by the disclaimer copy explicitly recommending the operator sync the backups directory off-host. The alternative (separate volume) would force every operator to configure two mounts even when one is enough.

## Migration Plan

1. Ship the change behind no feature flag. First boot of the new server:
   - Creates `<data-dir>/backups/` with mode 0700 if missing.
   - Runs the pending drizzle migrations as usual. The pre-migration hook fires for each → produces one or more `pre-migration-<schema>-<ISO>.db` files.
   - Starts the rotation scheduler.
2. Release notes call out:
   - New directory appears under the data volume.
   - One-time pre-migration snapshot is produced on first boot (helps cover the upgrade itself).
   - Default behaviour can be tuned with the three env vars.
3. No rollback complexity: rolling back the server version stops the scheduler. The snapshots already on disk remain; the old server doesn't know about them but doesn't trip over them either (it never lists `<data-dir>/backups/`).
