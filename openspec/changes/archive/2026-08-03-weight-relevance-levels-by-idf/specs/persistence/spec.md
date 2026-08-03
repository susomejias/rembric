## ADDED Requirements

### Requirement: Term statistics MUST be exposed by a contentless vocabulary table over `memory_fts`

The relevance level's weighting needs per-term document frequencies over the full-text index. The schema SHALL expose them through an `fts5vocab` virtual table in the `row` form over `memory_fts`, declared in a migration, rather than by counting terms in application code or by maintaining a term table of its own.

The table SHALL store nothing: it is a read-only view over the postings `memory_fts` already maintains, so it holds no contents to invalidate, needs no backfill on an existing installation, and requires no recipe version marker — the DDL is the recipe (see "Every derived table MUST be reproducible from source tables by a pinned recipe"). It is classified as **derived**.

Its migration SHALL be DDL-only. It SHALL NOT rebuild a table, so the foreign-key dance the table-rebuild migrations require does not apply, and a virtual table contributes no rows to `PRAGMA foreign_key_check`.

It SHALL NOT be added to the operator-visible table counts the startup shrinkage guard compares, whose population is `memory`, `projects`, `sessions`, `tokens` and `prompts`: its row count is a term count, which moves for reasons that are not data loss.

Because it resolves `memory_fts` by name at query time, a migration that drops and recreates `memory_fts` SHALL leave it working afterwards with no DDL change, and SHALL NOT be required to drop and recreate it. A read issued between the drop and the recreate fails, so no such migration SHALL leave that window open to a serving request.

#### Scenario: The vocabulary table is populated the moment it exists

- **GIVEN** an existing installation whose `memory_fts` index already holds hundreds of memories
- **WHEN** the migration creating the vocabulary table applies
- **THEN** it SHALL report a document frequency for terms already indexed, with no backfill step and no first-boot work

#### Scenario: An FTS rebuild is reflected without touching the vocabulary table

- **GIVEN** the vocabulary table exists
- **WHEN** `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` is run
- **THEN** subsequent reads of the vocabulary table SHALL reflect the rebuilt index, and no DDL SHALL be required

#### Scenario: Recreating the FTS table does not orphan the vocabulary table

- **GIVEN** a migration that drops `memory_fts` and recreates it
- **WHEN** the migration completes
- **THEN** reads of the vocabulary table SHALL succeed against the recreated index without the migration having redeclared it

#### Scenario: The vocabulary table does not trip the shrinkage guard

- **WHEN** the startup shrinkage guard reads its table counts
- **THEN** the vocabulary table SHALL NOT be among them

### Requirement: The query-tokenising table MUST be a per-connection object, not part of the durable schema

Tokenising a query through the index's own tokenizer needs a second FTS5 table (see the `memory` capability, "Term-statistics lookups MUST be keyed on the index's own terms"). That table is scratch space for one statement's worth of text, not data, and SHALL NOT enter the durable schema: it SHALL be created in the connection's temporary schema at startup and SHALL NOT be created by a migration.

The consequences SHALL hold in all of the following forms. It SHALL be contentless, storing postings and no text. Writing to it SHALL NOT grow the durable database or its write-ahead log. It SHALL NOT appear in the migration ledger, in the schema-drift inventory, or in the startup shrinkage guard's table counts. Because it is per-connection it SHALL be recreated on every process start rather than persisted, and no upgrade, downgrade or rollback SHALL have to account for it.

Its creation SHALL happen after migrations have applied, because its declaration is derived from the shipped declaration of `memory_fts`, which a migration may still be about to change. Deriving it before migrations run would pin the previous tokenizer for the life of the process.

It SHALL be emptied before each query is tokenised, so that the terms read back are the terms of that query alone and never of a previous one.

#### Scenario: The tokenising table is absent from the durable schema

- **WHEN** the durable schema of a running installation is inspected
- **THEN** the tokenising table SHALL NOT be present in it, SHALL NOT appear in the migration ledger, and SHALL NOT appear in the schema-drift inventory

#### Scenario: Tokenising queries does not grow the database

- **GIVEN** a running installation
- **WHEN** many searches are issued
- **THEN** neither the database file nor its write-ahead log SHALL grow on account of tokenising those queries

#### Scenario: The declaration is derived after migrations, not before

- **GIVEN** a release whose migrations change `memory_fts`'s declared tokenizer
- **WHEN** the process starts
- **THEN** the tokenising table SHALL be declared with the tokenizer the migrations left in place, not the one that preceded them

#### Scenario: One query's terms do not leak into the next

- **GIVEN** two consecutive searches with disjoint vocabularies
- **WHEN** the second query's terms are read back
- **THEN** they SHALL contain no term contributed by the first
