## ADDED Requirements

### Requirement: The maintenance page MUST expose a SNAPSHOTS panel

`/dashboard/maintenance` SHALL render a SNAPSHOTS panel above the existing physical-purge panels. The panel SHALL list every snapshot present under `<data-dir>/backups/` with its corresponding journal row in `consolidation_ops`, render the columns `timestamp · size · trigger · file · download · restore`, and SHALL surface a primary `[SNAPSHOT NOW]` button. The page SHALL re-fetch the snapshot list on every GET (no caching).

#### Scenario: Empty backups directory

- **GIVEN** `<data-dir>/backups/` is empty
- **WHEN** an admin visits `/dashboard/maintenance`
- **THEN** the SNAPSHOTS panel SHALL render with a "no snapshots yet" empty-state row and the `[SNAPSHOT NOW]` button SHALL remain enabled

#### Scenario: Snapshot list ordering

- **GIVEN** the backups directory contains automatic, manual, and pre-migration snapshots
- **WHEN** the SNAPSHOTS panel renders
- **THEN** the rows SHALL be ordered by timestamp descending, and the `trigger` column SHALL display `AUTO`, `MANUAL`, or `PRE-MIGRATION` matching the journal row's `metadata.trigger`

#### Scenario: Auto-backup disabled banner

- **GIVEN** the server started with `REMBRIC_BACKUP_DISABLE=true`
- **WHEN** an admin visits `/dashboard/maintenance`
- **THEN** the SNAPSHOTS panel SHALL render an explicit "auto-backup disabled by env" banner above the table

### Requirement: The SNAPSHOTS panel MUST expose a CSRF-protected manual snapshot trigger

The `[SNAPSHOT NOW]` button SHALL POST to a CSRF-protected endpoint, the server SHALL produce a snapshot synchronously via the same `VACUUM INTO` path used by the scheduler, and the response SHALL htmx-swap the snapshot table to include the new row.

#### Scenario: Manual snapshot from the dashboard

- **GIVEN** an authenticated admin is on `/dashboard/maintenance`
- **WHEN** the admin clicks `[SNAPSHOT NOW]` with a valid CSRF token
- **THEN** a file named `manual-<ISO>.db` SHALL appear in `<data-dir>/backups/`, a journal row with `metadata.trigger = 'manual'` SHALL be present in `consolidation_ops`, and the panel SHALL display the new row at the top of the list within one HTTP round-trip

#### Scenario: Missing CSRF token

- **WHEN** a request to the snapshot-now endpoint arrives without a valid CSRF token
- **THEN** the server SHALL respond with 403 and SHALL NOT produce a snapshot

### Requirement: The SNAPSHOTS panel MUST expose a snapshot download endpoint

Each snapshot row SHALL provide a download link that streams the `.db` file from `<data-dir>/backups/` with `Content-Disposition: attachment; filename="<basename>"` and the body content type `application/vnd.sqlite3`.

#### Scenario: Operator downloads a snapshot

- **WHEN** an admin clicks the download link for `data-<ISO>.db`
- **THEN** the response SHALL stream the file's bytes with `Content-Disposition: attachment; filename="data-<ISO>.db"` and `Content-Type: application/vnd.sqlite3`, and the file on disk SHALL remain untouched

#### Scenario: Download path traversal attempt

- **WHEN** the download endpoint is called with a `file` parameter that resolves outside `<data-dir>/backups/`
- **THEN** the server SHALL respond with 400 and SHALL NOT read the requested path

### Requirement: The SNAPSHOTS panel MUST expose a restore-from-snapshot action gated by the data-confirm modal

Each snapshot row SHALL provide a `[RESTORE]` form whose `<form>` element declares `data-confirm`, `data-confirm-label`, and `data-confirm-tone="warn"`. The restore handler SHALL rename the live `data.db` to `data.db.pre-restore-<ISO>`, copy the chosen snapshot in its place, write a `<data-dir>/restart_required` flag file, and return a response that explicitly tells the operator to restart the server process. The handler SHALL NOT attempt a hot-swap of the DB handle.

#### Scenario: Restore copy on confirmed restore

- **GIVEN** an admin clicks `[RESTORE]` for `data-2026-05-18T08-00-00Z.db` and confirms the modal
- **WHEN** the restore endpoint executes
- **THEN** the live `data.db` SHALL be renamed to `data.db.pre-restore-<ISO>`, the chosen snapshot SHALL be copied to `data.db`, a `restart_required` flag file SHALL be created under `<data-dir>`, and the response body SHALL contain a clear "restart required" instruction

#### Scenario: Modal copy describes the irreversibility-with-escape-hatch

- **WHEN** the restore modal renders for a chosen snapshot
- **THEN** the `data-confirm` text SHALL name the snapshot file, SHALL warn that the server is still running with the OLD database until restarted, SHALL state that the operator must restart the process or container, and SHALL mention the auto-saved `data.db.pre-restore-*` copy as the escape hatch

#### Scenario: Server boot picks up restore on next start

- **GIVEN** a restore was performed and the `restart_required` flag file exists in the data directory
- **WHEN** the server starts
- **THEN** the startup banner SHALL log "restored from snapshot — operator-initiated" with the snapshot filename, and the flag file SHALL be removed once the server is serving traffic

#### Scenario: Restore source outside backups directory rejected

- **WHEN** the restore endpoint is called with a `file` parameter that resolves outside `<data-dir>/backups/`
- **THEN** the server SHALL respond with 400 and SHALL NOT touch the live `data.db`
