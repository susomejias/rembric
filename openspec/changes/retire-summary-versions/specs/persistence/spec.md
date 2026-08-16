## ADDED Requirements

### Requirement: The `session_summary_versions` table MUST be dropped by a dedicated migration, with `0033` retained on disk

A migration SHALL drop `session_summary_versions`. Its body SHALL be exactly one statement:

```sql
DROP TABLE session_summary_versions;
```

**No table rebuild, and the reason is structural rather than economical.** `session_summary_versions` references `sessions(id)` and nothing references `session_summary_versions`; it is a child, never a parent. The `FOREIGN KEY constraint failed`-on-`DROP TABLE` hazard that forces the `CREATE … / INSERT … SELECT / DROP / RENAME` dance applies to dropping a PARENT of a populated child, which this is not. The named unique index and the primary-key autoindex are dropped by SQLite with the table and SHALL NOT be dropped by statements of their own.

**No pragma of any kind SHALL appear in the migration.** The runner already wraps every migration in `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `PRAGMA foreign_key_check` → `COMMIT` → `PRAGMA foreign_keys = ON` (see "The migration runner MUST disable `foreign_keys` around each migration transaction"), and an author-supplied pragma is forbidden by the invariant that pins that behaviour.

**`0033_session_summary_versions.sql` SHALL remain on disk, unmodified.** The runner reads the migration directory and skips filenames already recorded in `_migrations`, so deleting an applied migration errors nowhere — it silently does nothing on an upgraded install and silently changes the outcome on a fresh one, leaving two databases at the same schema version with different applied histories. Retaining the creating migration and adding a dropping one is the pattern this schema already uses for `0011_summary_length_check.sql` / `0012_drop_summary_length_check.sql`. A fresh install therefore creates the table and immediately drops it, ending in exactly the state an upgraded install reaches. The migration filename list pinned by the migration tests SHALL gain the new entry and SHALL NOT lose `0033`.

**The row loss is total and irreversible, and this requirement SHALL say so rather than imply otherwise.** Every stored version row is destroyed. No mechanism in this system can return them: `consolidation_ops` records identifiers, never payloads, and there is no export step, no archival table and no journal of summary text. The only copy an operator can have is a file-level backup taken before the upgrade, per the documented backup procedure. `sessions.summary` is NOT touched by the migration, so no session's current summary is affected in any way.

**No backfill, no data movement, no write to any other table.** The migration reads nothing and writes nothing outside the `DROP`.

**Rolling back to a pre-drop image BREAKS the curated write path, and this is the first migration in this schema for which that is true.** A pre-drop image inserts into a table that no longer exists, so the whole curated-write transaction fails and `memory.session_summary` stops working; the dashboard session detail page fails on its history read. `_migrations` still records the drop, so simply restarting the older image does not restore the table. The documented recoveries are to roll forward, or to recreate the empty table by hand from the `0033` DDL still present in the tree. This requirement SHALL NOT be read as making the drop reversible.

#### Scenario: The migration runs against a populated data file carrying version rows

- **GIVEN** an existing database with sessions, memories, prompts and confirmations, including sessions whose `session_summary_versions` rows are non-empty
- **WHEN** the server boots on the new image and the migration runner applies the drop
- **THEN** `session_summary_versions` SHALL NOT exist afterwards
- **AND** every row of `sessions`, `memory`, `prompts` and `confirmations` SHALL be byte-identical to before the migration, including every `sessions.summary` value
- **AND** `PRAGMA foreign_key_check` SHALL report no violations before `COMMIT`

#### Scenario: The drop needs no table rebuild

- **WHEN** the migration file is inspected
- **THEN** it SHALL contain exactly one `DROP TABLE` statement and no `CREATE TABLE`, no `INSERT … SELECT`, no `ALTER TABLE … RENAME`, and no `PRAGMA`
- **AND** it SHALL NOT drop the table's index by name — the index goes with the table

#### Scenario: A fresh install ends in the same state as an upgraded one

- **GIVEN** an empty data file
- **WHEN** the full migration chain is applied from `0001`
- **THEN** `_migrations` SHALL record both `0033_session_summary_versions.sql` and the dropping migration, in that order
- **AND** `session_summary_versions` SHALL NOT exist in the resulting schema
- **AND** the resulting table set SHALL equal the table set of a database upgraded from a pre-`0033` file

#### Scenario: Re-running the migration chain is a no-op

- **GIVEN** a database on which the drop has already been applied
- **WHEN** the server boots again
- **THEN** the runner SHALL apply nothing, and SHALL NOT fail attempting to drop a table that is already gone

#### Scenario: Derived tables need no invalidation

- **WHEN** the migration completes
- **THEN** `memory_fts`, `memory_fts_vocab`, `prompts_fts`, `memory_replaces`, `memory_vec` and the three entity tables SHALL be untouched and SHALL require no rebuild, because the dropped table was a source table that no derived table derived from

#### Scenario: The startup shrink guard is not tripped by the drop

- **GIVEN** a database whose `session_summary_versions` held many rows before the upgrade
- **WHEN** the server boots on the new image
- **THEN** the operator-visible-table shrink guard SHALL NOT refuse startup, because the dropped table is not one of the tables it counts

#### Scenario: Downgrading to a pre-drop image breaks the curated write path

- **GIVEN** a database on which the drop has been applied
- **WHEN** the operator runs a pre-drop image against it
- **THEN** a curated `memory.session_summary` write SHALL fail, because the older code inserts into a table that no longer exists
- **AND** `_migrations` SHALL still record the drop, so restarting the older image SHALL NOT restore the table
- **AND** the documented recovery SHALL be to roll forward, or to recreate the empty table from the retained `0033` DDL

## REMOVED Requirements

### Requirement: Migration `0033_session_summary_versions.sql` MUST create the summary-version table additively, with no backfill

**Reason**: Every normative clause in this requirement is about a table that no longer exists at the end of the migration chain — its DDL, why its uniqueness constraint is a named index, why it carries no secondary index, why it carries no `CHECK` on `content`, why no backfill is possible, and the raised cost it imposed on any future rebuild of `sessions`. That last clause is the only one with residual value and it is now false in the helpful direction: `sessions` loses a cascading child, so a later rebuild of `sessions` has one fewer FK to recreate.

The migration FILE is not removed — see "The `session_summary_versions` table MUST be dropped by a dedicated migration, with `0033` retained on disk", which keeps it on disk deliberately and records why. What is removed is the standing REQUIREMENT that the schema carry the table `0033` creates.

**Migration**: None for the operator beyond the drop itself, which the ADDED requirement above specifies. The migration test dedicated to `0033` is deleted rather than retained as a checkpoint pin: two of its five cases drive `AgentSessionsService` and the repository's summary-version reads, neither of which survives, so it cannot be kept green by slicing the migration directory. A new migration test covers the drop instead.
