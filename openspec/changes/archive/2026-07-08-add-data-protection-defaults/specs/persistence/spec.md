## ADDED Requirements

### Requirement: The server MUST run a default-on auto-backup scheduler

The server SHALL start a background scheduler on boot that produces a snapshot of the SQLite database at a configurable interval, writes it to `<data-dir>/backups/`, and rotates by keeping only the most recent N automatic snapshots. The scheduler SHALL be ON by default and tunable via three environment variables: `REMBRIC_BACKUP_INTERVAL_MS` (default `21600000` — six hours), `REMBRIC_BACKUP_KEEP` (default `7`), and `REMBRIC_BACKUP_DISABLE` (default `false`).

#### Scenario: Default boot creates the backups directory and starts the scheduler

- **GIVEN** a fresh data directory with no `backups/` subdirectory
- **WHEN** the server starts with no `REMBRIC_BACKUP_*` env vars set
- **THEN** the server SHALL create `<data-dir>/backups/` with mode 0700 and SHALL register a setInterval-based scheduler with a 21600000 ms period

#### Scenario: Disabling via env var short-circuits the scheduler

- **GIVEN** `REMBRIC_BACKUP_DISABLE=true` is set in the environment
- **WHEN** the server starts
- **THEN** the server SHALL NOT register the scheduler and SHALL NOT create the backups directory if it does not already exist, and the dashboard SHALL render an explicit "auto-backup disabled by env" badge in the snapshots panel

#### Scenario: Rotation drops the oldest automatic snapshot when KEEP is exceeded

- **GIVEN** `REMBRIC_BACKUP_KEEP=3` is set and three automatic snapshots already exist
- **WHEN** the scheduler produces a fourth automatic snapshot
- **THEN** the server SHALL unlink the oldest automatic snapshot in the same operation, leaving exactly three automatic snapshots on disk

#### Scenario: Rotation MUST NOT touch pre-migration or manual snapshots

- **GIVEN** the backups directory contains 7 automatic snapshots, 3 pre-migration snapshots, and 2 manual snapshots
- **WHEN** the scheduler produces a new automatic snapshot
- **THEN** rotation SHALL only consider snapshots whose `trigger` is `auto`; pre-migration and manual snapshots SHALL remain on disk regardless of count

### Requirement: Snapshot files MUST be produced via `VACUUM INTO` and live under `<data-dir>/backups/`

Every snapshot — regardless of trigger — SHALL be produced by executing `VACUUM INTO '<path>'` against the live database. The destination path SHALL always be under `<data-dir>/backups/` resolved to an absolute path. The filename SHALL encode the trigger and a UTC timestamp: `data-<ISO>.db` for automatic, `manual-<ISO>.db` for dashboard-triggered, and `pre-migration-<schema-version>-<ISO>.db` for migration-triggered.

#### Scenario: `VACUUM INTO` target outside the backups directory is rejected

- **WHEN** any code path attempts to invoke `VACUUM INTO` with a destination resolving outside `<data-dir>/backups/`
- **THEN** the operation SHALL throw a `BackupTargetEscapeError` before the SQLite call is issued

#### Scenario: Snapshot file is written atomically from the operator's perspective

- **WHEN** a snapshot operation runs
- **THEN** the destination file SHALL appear at its final path with valid SQLite contents, or it SHALL NOT exist at all; partially written files SHALL NOT be observable

### Requirement: A pre-migration snapshot MUST be taken before any drizzle migration applies

The migration runner SHALL produce a snapshot named `pre-migration-<current-schema-version>-<ISO>.db` BEFORE issuing any DDL statement on boot, and only when at least one pending migration exists. Pre-migration snapshots SHALL be exempt from rotation; they remain on disk until the operator deletes them.

#### Scenario: Pending migration triggers a pre-migration snapshot

- **GIVEN** the data directory contains a DB at schema version 12 and the server bundle includes migration 13
- **WHEN** the server starts
- **THEN** a file `pre-migration-12-<ISO>.db` SHALL be produced under `<data-dir>/backups/` BEFORE migration 13 runs, and the `consolidation_ops` journal SHALL contain a row with `op_type = 'backup_snapshot'` and `metadata.trigger = 'pre-migration'`

#### Scenario: Up-to-date DB skips the pre-migration snapshot

- **GIVEN** the data directory's DB is already at the latest schema version known to the server bundle
- **WHEN** the server starts
- **THEN** no pre-migration snapshot SHALL be produced, and no `pre-migration` row SHALL be added to `consolidation_ops`

### Requirement: Every snapshot MUST be journaled in `consolidation_ops` atomically with the file produced

Each snapshot operation SHALL write exactly one row to `consolidation_ops` with `op_type = 'backup_snapshot'` and a `metadata` JSON object containing `trigger` (`auto` | `manual` | `pre-migration`), `file_path` (relative to `<data-dir>`), `bytes` (file size), and `schema_version`. The journal row SHALL be written in the same `better-sqlite3` transaction as the `VACUUM INTO` call so that no orphan files or orphan rows can exist.

#### Scenario: File write succeeds but journal commit fails

- **WHEN** `VACUUM INTO` succeeds but the subsequent `INSERT INTO consolidation_ops` fails (e.g., disk full mid-transaction)
- **THEN** the snapshot file SHALL be unlinked as part of transaction rollback so the disk state matches the journal state

#### Scenario: Journal insert succeeds but file is removed externally

- **GIVEN** a journal row exists for a snapshot file that has since been deleted from disk
- **WHEN** the dashboard renders the snapshots list
- **THEN** the entry SHALL be flagged "file missing on disk" so the operator can prune the orphan journal row from the consolidation page

### Requirement: The `consolidation_ops.op_type` Drizzle enum MUST include `'backup_snapshot'`

The TypeScript-level union for `consolidation_ops.op_type` SHALL be extended to include `'backup_snapshot'` alongside the existing values. Because the underlying column is `TEXT` with no CHECK constraint, this SHALL NOT require a database migration; the change SHALL be limited to `src/db/schema/consolidation.ts` and the operation handlers that read or write this column.

#### Scenario: Older binaries reading new rows

- **GIVEN** a journal row exists with `op_type = 'backup_snapshot'`
- **WHEN** an older server binary reads the `consolidation_ops` table
- **THEN** the row SHALL be readable as a generic `TEXT` row even though the older binary cannot enumerate it as a known op type; the older binary SHALL NOT crash

### Requirement: ONLY designated files MAY invoke `VACUUM INTO`

`VACUUM INTO` SHALL be emitted exclusively from `src/backup/storage.ts` and `src/dashboard/maintenance.ts`. The invariants test suite SHALL pin this allow-list with positive assertions (the named files contain the call) and negative assertions (no other tracked file contains it).

#### Scenario: A new file adds `VACUUM INTO` without updating the invariants test

- **WHEN** a contributor adds `db.exec("VACUUM INTO ...")` to a file outside the allow-list
- **THEN** `src/test/invariants.test.ts` SHALL fail with a message naming the offending file and pointing at the allow-list location

#### Scenario: An allow-listed file silently drops its `VACUUM INTO` call

- **WHEN** a refactor removes the `VACUUM INTO` call from `src/backup/storage.ts`
- **THEN** the invariants test SHALL fail because the positive assertion that the file contains the call no longer holds
