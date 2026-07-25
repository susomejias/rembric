## MODIFIED Requirements

### Requirement: The entity tables MUST be declared derived, never primary

All THREE entity tables — `memory_entities`, `memory_entity_links` and `memory_entity_scan` — SHALL be documented and treated as derived data, in the same class as the search and vector indexes: recomputable in full from the append-only memory rows, and never the sole record of anything. No agent-supplied information SHALL exist only in the entity index — everything in it is recoverable by re-running extraction over `title + content`.

The scan table is bookkeeping rather than knowledge, but it is not therefore exempt: it records THAT a memory was scanned, which is what lets the resumable drain tell "processed, found nothing" from "not yet processed". Any operation that empties the index SHALL empty the scan table too, or the drain finds no work and the index stays empty — so the classification covers all three, and a procedure phrased over "both tables" is a defect.

This classification is what permits the index to be truncated and rebuilt, and it SHALL be stated where the tables are defined so a future contributor does not begin storing primary information there.

#### Scenario: The index is truncated and rebuilt with no loss

- **GIVEN** a populated entity index
- **WHEN** all three tables are emptied and the rebuild is run
- **THEN** the resulting index SHALL be equivalent to the one that was emptied

#### Scenario: Emptying only two tables does not rebuild

- **GIVEN** a populated entity index
- **WHEN** `memory_entities` and `memory_entity_links` are emptied but `memory_entity_scan` is not
- **THEN** the drain SHALL find nothing to re-scan and the index SHALL remain empty

#### Scenario: Losing the index loses no agent-supplied information

- **WHEN** the entity tables are dropped entirely
- **THEN** every memory's `title`, `content`, `tags`, `topic_key`, `status` and `replaces` SHALL be unaffected

### Requirement: Documented backup and restore procedures MUST be executable against the distributed artifact

The distributed runtime stage is a distroless image: it has no shell and no `sqlite3` binary. Any documented backup procedure that shells into the container therefore cannot run, and an operator following it acquires no backups while believing they have them. Documented procedures SHALL be limited to mechanisms that work against the distributed artifact: the dashboard's snapshot-and-download flow while the server runs, and a cold copy of the database file from the host bind mount while the server is stopped.

An automation path SHALL NOT be documented against an endpoint that cannot authenticate it. The dashboard backup route authenticates by session cookie and CSRF token, so a cron job holding a bearer token is redirected to the login page and acquires zero backups while reporting success — the same class of failure as the shell-in procedure. Unattended backup SHALL be documented as litestream or a scripted cold copy.

Restore SHALL be documented end to end, and SHALL cover all three of:

1. **The derived-index recipe markers.** The bookkeeping for "already processed" lives INSIDE the database (`memory_entity_scan`, `memory_vec`) while the recipe identity lives OUTSIDE it, in `entity-state.json` / `embedding-state.json`. The documented procedure SHALL instruct the operator to delete both markers before booting on a restored database, and SHALL state the direction of the hazard: a MISSING marker is safe (identity unknown → wipe and re-derive), while a SURVIVING marker that MATCHES the running build is the trap — the wipe is skipped, the fully-populated scan table makes the backfill drain a no-op, and the index stays pinned to the recipe that built the snapshot indefinitely with no error surfaced anywhere. The intuition runs the other way, which is why it SHALL be stated explicitly rather than implied.
2. **The data-loss guard**, with its real trigger rather than a paraphrase: it compares the monitored tables (`memory`, `projects`, `sessions`, `tokens`, `prompts`) against the counts in the state marker and refuses to boot only when a table's PREVIOUS count was above zero AND its new count is below half of it. A snapshot that is merely older or slightly smaller boots normally, and so does a restore into a deployment that had no marker.
3. **How the acknowledgement variable actually reaches the process.** The canonical compose service passes `env_file: .env` and declares no `environment:` block, so a host-shell assignment prefixed onto `docker compose up` is consumed as compose-file interpolation and never injected into the container: the operator runs the documented command verbatim and gets the identical refusal. The variable SHALL be documented as an `.env` entry, and it SHALL be documented in the operator-facing configuration reference rather than appearing only in a boot error message.

The snapshot download surface SHALL allow the operator to select which snapshot to download, including the mandatory pre-update snapshots, rather than serving only the most recent on-demand file.

#### Scenario: An operator follows the documented backup procedure

- **WHEN** an operator runs the documented backup commands against a container built from the published image
- **THEN** every documented command SHALL succeed

#### Scenario: An operator restores an older snapshot

- **GIVEN** a snapshot with under half the live row count in a monitored table
- **WHEN** the operator follows the documented restore procedure
- **THEN** the procedure SHALL state that the data-loss guard will refuse boot, SHALL name the acknowledgement variable, and SHALL say where it has to be set for the container to see it

#### Scenario: The restore procedure clears the recipe markers

- **WHEN** the documented restore procedure is followed
- **THEN** it SHALL delete `entity-state.json` and `embedding-state.json` before the first boot, and SHALL explain that a surviving matching marker silently pins the derived index to the snapshot's recipe

#### Scenario: Unattended backup is not documented against the dashboard form

- **WHEN** the documented procedures are read for an automation path
- **THEN** they SHALL point at litestream or a scripted cold copy, and SHALL NOT claim the dashboard backup route accepts a bearer token

#### Scenario: A pre-update snapshot is downloadable

- **GIVEN** a data directory containing both on-demand and pre-update snapshots
- **WHEN** the operator opens the maintenance view
- **THEN** each snapshot SHALL be individually downloadable

## ADDED Requirements

### Requirement: The entity index DDL MUST be recorded, with its identity index named as the isolation guarantee

The entity tables are the only derived tables whose DDL no requirement records, which leaves their cross-project isolation guarantee living in a code comment. `0023_memory_entities.sql` SHALL declare:

- `memory_entities` — `id` TEXT PRIMARY KEY, `scope` TEXT NOT NULL, `project_id` TEXT REFERENCES `projects(id)`, `kind` TEXT NOT NULL, `value` TEXT NOT NULL, `created_at` INTEGER NOT NULL.
- `memory_entity_links` — `entity_id` TEXT NOT NULL REFERENCES `memory_entities(id)`, `memory_id` TEXT NOT NULL REFERENCES `memory(id)`, PRIMARY KEY `(entity_id, memory_id)`, `WITHOUT ROWID`. The composite key leads with `entity_id` because the load-bearing access pattern is "every memory linked to this entity"; `memory_entity_links_memory_idx (memory_id)` serves the opposite direction (a memory's own `entities[]`).
- `memory_entity_scan` — `memory_id` TEXT PRIMARY KEY REFERENCES `memory(id)`, `scanned_at` INTEGER NOT NULL, `WITHOUT ROWID`.

`CREATE UNIQUE INDEX memory_entities_identity_idx ON memory_entities (scope, project_id, kind, value)` is the STRUCTURAL guarantee that an identifier in project A cannot join project B's memories: entity identity is the four-tuple, so the same literal string in two scopes is two rows with two ids and no link between them. Scope isolation on the entity path therefore does not depend on a service remembering to filter — the join has nothing to cross. This index SHALL be treated as load-bearing rather than as a de-duplication convenience, and it SHALL be declared in the Drizzle schema as well as the migration.

The `WITHOUT ROWID` declarations on the two child tables cannot be expressed in Drizzle; the schema-drift test asserts them against `sqlite_master` instead. No trigger on `memory` maintains these tables — extraction needs the JS regex extractor, which SQL cannot run — so this migration adds no trigger and needs no table rebuild.

#### Scenario: The identity index rejects a duplicate referent

- **GIVEN** an entity row for `(project:'A', 'path', 'src/index.ts')`
- **WHEN** a second row with the same four-tuple is inserted
- **THEN** the insert SHALL be rejected by the unique index

#### Scenario: The same value in two scopes is two entities

- **WHEN** `(project:'A', 'path', 'src/index.ts')` and `(project:'B', 'path', 'src/index.ts')` are both present
- **THEN** they SHALL be two rows with distinct ids, and no link table row SHALL connect either project's memories to the other's

#### Scenario: The child tables are WITHOUT ROWID

- **WHEN** `sqlite_master` is inspected after migration
- **THEN** `memory_entity_links` and `memory_entity_scan` SHALL both be declared `WITHOUT ROWID`

### Requirement: `sessions.last_activity_at` and `confirmations.verdict`/`reason` MUST be additive migrations

Both columns were added to populated tables in shipped installs, so their migrations SHALL be additive — `ALTER TABLE … ADD COLUMN`, no rebuild, no FK dance — and SHALL leave every pre-existing row immediately classifiable rather than in a null limbo the reading code has to special-case forever.

`0022_session_last_activity.sql` SHALL add `last_activity_at INTEGER` (nullable) to `sessions` and SHALL backfill it from `started_at` for every existing row, so a row saved before the column existed is retired on the same rule as a new one. The column stays nullable rather than NOT NULL: readers use `COALESCE(last_activity_at, started_at)`, which keeps a row written by an older binary correct instead of merely non-null.

`0024_confirmation_verdict.sql` SHALL add `verdict TEXT NOT NULL DEFAULT 'affirm'` and `reason TEXT` (nullable) to `confirmations`. The default is what makes the migration additive: every pre-existing confirmation IS an affirmation, so the backfill is free and no historical row is reinterpreted. `reason` is nullable at the DB level and required only for a refutation, which is enforced at the service layer — the domain of `verdict` is likewise service-enforced, with no DB `CHECK` (see the open question recorded in this change's design).

#### Scenario: An existing session row is classifiable immediately after upgrade

- **GIVEN** a database with `active` sessions written before `0022`
- **WHEN** the migration runs
- **THEN** every row SHALL have `last_activity_at` equal to its `started_at`

#### Scenario: Existing confirmations remain affirmations

- **GIVEN** a database with confirmation rows written before `0024`
- **WHEN** the migration runs
- **THEN** every row SHALL read `verdict = 'affirm'` and the affirmation count for each memory SHALL be unchanged

#### Scenario: Neither migration rebuilds its table

- **WHEN** `0022` and `0024` are inspected
- **THEN** each SHALL consist of `ALTER TABLE … ADD COLUMN` (plus, for `0022`, one backfill `UPDATE`), with no `CREATE TABLE … _new`, no `DROP TABLE`, and no index or trigger recreation
