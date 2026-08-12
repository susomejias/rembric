## ADDED Requirements

### Requirement: Migration `0033_session_summary_versions.sql` MUST create the summary-version table additively, with no backfill

The migration SHALL be purely additive: one `CREATE TABLE`, one named unique index, no table rebuild, no `ALTER TABLE` on `sessions`, and no row written to any existing table. It SHALL declare:

```sql
CREATE TABLE session_summary_versions (
  id         TEXT    PRIMARY KEY NOT NULL,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX session_summary_versions_session_version_unq
  ON session_summary_versions (session_id, version);
```

`title` is nullable and carries the `sessions.title` value in effect when the row was written (`sessions`, revising design D6). It is declared in this same migration rather than a follow-up one: nothing on this branch has been pushed, `0033` has never shipped in a release, and a second migration for a column on a table no release ever had would describe history that never happened.

The uniqueness constraint SHALL be a NAMED unique index rather than a table-level `UNIQUE (…)` clause, so it appears in the schema-drift inventory by name like every other index in this schema, instead of as an anonymous auto-index.

**No index beyond that one SHALL be created.** Both reads the design has — the newest row for one session (`ORDER BY version DESC LIMIT 1`) and every row for one session, ordered — are served by it, since SQLite can scan an index in either direction. A further index SHALL NOT be added without a measurement showing this one insufficient: an unmeasured index is a write cost against an unestablished read benefit.

**No `CHECK` on `content` length SHALL be declared.** The cap is `SUMMARY_MAX_CHARS`, enforced solely in the server, and a value-pinning `CHECK` would make the cap require a migration — which the `sessions` capability forbids for exactly this column's value ("Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary`").

**No backfill SHALL be performed**, and the reason is normative rather than economic. A version row asserts that its `content` was the stored summary as of its `created_at`, and for a pre-existing curated summary that timestamp is not recorded anywhere: `sessions` carries `started_at`, `ended_at` and `last_activity_at`, none of which is the moment a summary was written. A backfill would therefore have to invent the one field the row exists to carry. Pre-existing sessions consequently start with an empty history and keep their `summary` column verbatim; the version invariant is scoped to sessions that HAVE at least one version row, precisely so that it holds on a populated file from the first boot.

**Foreign-key safety.** The table is a new CHILD of `sessions`, so any future migration that rebuilds `sessions` will `DROP TABLE` a parent with a populated child. The runner's existing pragma sequence (`PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `PRAGMA foreign_key_check` → `COMMIT`) is what makes that safe, and migration authors SHALL NOT add pragmas of their own. This requirement records the raised cost so a later rebuild of `sessions` recreates this FK rather than dropping it silently.

#### Scenario: The migration runs against a populated data file

- **GIVEN** an existing database with sessions, memories, prompts and confirmations, including sessions carrying curated summaries
- **WHEN** the server boots on the new image and the migration runner applies `0033`
- **THEN** the `session_summary_versions` table SHALL exist and SHALL be empty
- **AND** every pre-existing row in every table SHALL be byte-identical to before the migration
- **AND** `PRAGMA foreign_key_check` SHALL report no violations before `COMMIT`

#### Scenario: A curated summary written before the upgrade keeps working afterwards

- **GIVEN** a session whose `summary` was written before the migration, with `summary_final = 1` and no version rows
- **WHEN** it is read through `memory.session_get`, `memory.context` and the dashboard after the upgrade
- **THEN** each SHALL return exactly what it returned before, and no read SHALL fail for the absence of version rows

#### Scenario: The next curated write on a pre-existing session starts the history at 1

- **GIVEN** the same pre-migration session, with a stored curated summary and zero version rows
- **WHEN** a new curated write lands
- **THEN** one version row SHALL be appended with `version = 1` and the NEW content
- **AND** the pre-migration text SHALL NOT be inferred into the table

#### Scenario: Rolling back to a pre-migration image loses no summary

- **GIVEN** a database on which `0033` has run and version rows exist
- **WHEN** the operator runs a previous image that knows nothing about the table
- **THEN** the table SHALL be left in place and unread, `sessions.summary` SHALL remain the authoritative current value, and no session summary SHALL be lost by the downgrade

#### Scenario: Derived tables need no invalidation

- **WHEN** the migration completes
- **THEN** `memory_fts`, `memory_vec` and the entity tables SHALL be untouched and SHALL require no rebuild, because the new table is a source table that no derived table derives from
