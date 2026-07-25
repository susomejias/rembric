## ADDED Requirements

### Requirement: Documented backup and restore procedures MUST be executable against the distributed artifact

The distributed runtime stage is a distroless image: it has no shell and no `sqlite3` binary. Any documented backup procedure that shells into the container therefore cannot run, and an operator following it acquires no backups while believing they have them. Documented procedures SHALL be limited to mechanisms that work against the distributed artifact: the dashboard's snapshot-and-download flow while the server runs, and a cold copy of the database file from the host bind mount while the server is stopped.

Restore SHALL be documented end to end, including the data-loss guard: replacing the live database with an older snapshot causes the guard to refuse boot, and its acknowledgement environment variable SHALL be documented in the operator-facing configuration reference rather than appearing only in a boot error message.

The snapshot download surface SHALL allow the operator to select which snapshot to download, including the mandatory pre-update snapshots, rather than serving only the most recent on-demand file.

#### Scenario: An operator follows the documented backup procedure

- **WHEN** an operator runs the documented backup commands against a container built from the published image
- **THEN** every documented command SHALL succeed

#### Scenario: An operator restores an older snapshot

- **GIVEN** a snapshot smaller than the live database
- **WHEN** the operator follows the documented restore procedure
- **THEN** the procedure SHALL state that the data-loss guard will refuse boot and SHALL name the acknowledgement variable required to proceed

#### Scenario: A pre-update snapshot is downloadable

- **GIVEN** a data directory containing both on-demand and pre-update snapshots
- **WHEN** the operator opens the maintenance view
- **THEN** each snapshot SHALL be individually downloadable
