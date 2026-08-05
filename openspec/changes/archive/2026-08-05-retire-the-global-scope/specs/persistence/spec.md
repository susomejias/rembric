## ADDED Requirements

### Requirement: The `projects` table MUST carry an `is_default` boolean marking the system default

The schema SHALL add `is_default INTEGER NOT NULL DEFAULT 0` to `projects`. Exactly one row SHALL hold `1`. The column is the default project's identity; the slug is not (see the `projects` capability).

The column is added by `ALTER TABLE … ADD COLUMN`, which requires no table rebuild.

The one-row invariant SHALL be enforced by the database, not only by the migration's guard and the service layer: the migration SHALL create a partial unique index `CREATE UNIQUE INDEX projects_is_default_uidx ON projects(is_default) WHERE is_default = 1`, so a second row holding `1` is rejected by SQLite rather than admitted. The index's value here is as a CONSTRAINT, not as a read path — a read gets nothing from it that the boolean does not already give, which is why an earlier draft of this requirement wrongly declined it on read-performance grounds. Two rows marked default would make path-less `/mcp` resolution non-deterministic, and a guard in the migration cannot prevent what a later bug, a manual `UPDATE`, or a restored snapshot can produce. `projects` already carries `projects_slug_unique`, so a unique index on this table is not a new pattern.

Adding the index means `apps/server/src/test/schema-drift.test.ts`'s pinned index set must gain it in the same commit; its going red first is the proof the index landed.

#### Scenario: The column is added without a table rebuild

- **WHEN** the migration is applied to a populated database
- **THEN** the column SHALL be added by `ALTER TABLE … ADD COLUMN`, every existing `projects` row SHALL keep its `id`, `slug`, `display_name`, `archived_at` and `created_at`, and no `projects` rowid SHALL move

#### Scenario: Exactly one row holds the flag

- **WHEN** the database is inspected after the migration
- **THEN** `SELECT count(*) FROM projects WHERE is_default = 1` SHALL be exactly 1

#### Scenario: A second default project is rejected by the database

- **GIVEN** a migrated database whose one default project is marked
- **WHEN** any writer — a later migration, the service layer, or a manual statement — attempts to set `is_default = 1` on a second row
- **THEN** SQLite SHALL reject the write on `projects_is_default_uidx`, and the existing default SHALL be unchanged
- **AND** a test SHALL assert that rejection directly, so the invariant is covered by the constraint rather than by the absence of a caller that violates it

### Requirement: A migration that repoints rows between scopes MUST be idempotent, crash-safe and reported

The migration retiring the global scope rewrites the partition identity of existing rows. Three properties SHALL hold, and each SHALL be verified by executing the migration rather than by reading it.

**Idempotent.** The body SHALL begin by probing for an existing default project (`SELECT … WHERE is_default = 1`) and SHALL insert one only if absent. Without that guard a re-run creates a second default project, which violates the one-row invariant silently. A second execution SHALL repoint zero rows.

**Crash-safe.** The runner writes the `_migrations` ledger row inside the same transaction as the migration body, so a crash mid-body leaves the database unchanged in every counted dimension and the ledger row unwritten, and the next boot retries. The migration SHALL NOT perform any step outside that transaction whose partial completion would be unrecoverable.

**Reported.** The migration runner SHALL narrate on the process log stream: which file it is applying, before that file's first statement runs; each slow step the file declares, before that step runs; and a summary naming the created default project's slug and the number of memory rows repointed into it. A migration that silently moves rows leaves an operator unable to answer "where did my memories go", and the change that retires a scope cannot ask for truthfulness on the agent surface while being silent on the operator one.

**The summary SHALL be emitted only after the transaction it summarises commits.** A report is post-hoc by definition, and the runner's pre-commit integrity gate can still veto a body whose report has already read as done — measured: an operator told `repointed 1 previously-global memory row(s) into the default project default` on a boot that then aborted with zero `projects` rows. Progress lines are the opposite case and SHALL be emitted inside the open write transaction, because their whole purpose is to arrive while the wait is happening.

**A report statement that reads as no rows, NULL, or a non-string value SHALL be an error, not a dropped line.** Report SQL is static text in a migration file, so a silently absent report is the same silent-absence failure the reports exist to prevent, one layer out — and it fails in the author's test run rather than on an operator's upgrade.

**The slug is unique by construction, not merely by probing.** The probe is bounded, so past its bound a candidate-selecting subquery returns NULL, `projects.slug` is NOT NULL, and the migration aborts — measured, with an error (`NOT NULL constraint failed: projects.slug`) that names neither the slug nor the collision, on a database that then never boots. The final candidate SHALL therefore be unconditional and unique by construction rather than probed.

**Scratch tables SHALL be `TEMP`.** A stash in the main database is pages the migration allocates and then frees, so it lands in the file's freelist and the file stays that much larger until an operator runs `VACUUM`. Measured at 200 000 repointed rows: `+159 MB` of file growth and a zero freelist with a TEMP stash, against `+988 MB` and an 829 MB freelist with a stash in the main file, and a faster body. The runner SHALL set `temp_store = FILE` around the body — `db/client.ts` pins `MEMORY` process-wide, which would make the stash resident memory instead (1585 MB peak RSS measured) and the worst case this runs in is a memory-capped container — and SHALL point SQLite's temp directory at the database's own, which is the filesystem the upgrade's disk requirement is stated against and the one the process has already proved it can write.

#### Scenario: Running the body twice creates one default project

- **GIVEN** a database the migration has already been applied to
- **WHEN** the migration body is executed again
- **THEN** exactly one row SHALL hold `is_default = 1`, no second project SHALL be created, and zero rows SHALL be repointed

#### Scenario: A crash mid-body leaves the database and the ledger untouched

- **GIVEN** a populated database and a fault injected part-way through the migration body
- **WHEN** the boot is attempted
- **THEN** every counted table total SHALL equal its pre-migration value, no `_migrations` row SHALL exist for this migration, and a subsequent boot SHALL apply it successfully

#### Scenario: The repointing is reported at boot

- **WHEN** the server boots for the first time after the migration is applied
- **THEN** the startup output SHALL name the default project's slug and the count of repointed memory rows
- **AND** the line naming the file being applied and the line preceding the vector step SHALL both have been emitted while the write transaction was still open

#### Scenario: A vetoed body reports nothing

- **GIVEN** a migration body whose report statement succeeds and whose pre-commit integrity gate then fails
- **WHEN** the boot is attempted
- **THEN** no summary SHALL reach the operator, because the work it describes was rolled back
- **AND** the progress lines emitted inside the transaction SHALL still have been seen, since their purpose is to narrate a wait that did happen

#### Scenario: A report statement that reads as nothing is an error

- **GIVEN** a migration whose `report` statement returns no rows
- **WHEN** the migration is applied
- **THEN** the runner SHALL fail loudly rather than emit nothing

#### Scenario: The slug is minted even when every probed candidate is taken

- **GIVEN** a database occupying every candidate slug the bounded probe can generate
- **WHEN** the migration is applied
- **THEN** it SHALL still create exactly one default project, with a slug that is unique and that `ProjectsService`'s own slug rule accepts

#### Scenario: The data-loss guard is not tripped by the repointing

- **GIVEN** a populated database
- **WHEN** the migration repoints every previously-global row and the server boots
- **THEN** the data-loss guard SHALL permit the boot, because every operator-visible table total is conserved
- **AND** a control in which 60% of `memory` rows are deleted SHALL still cause the guard to refuse the boot, so the permission is not vacuous

## MODIFIED Requirements

### Requirement: The `memory` table MUST gain a `topic_key` column

The schema SHALL add `topic_key TEXT` (nullable) to the `memory` table. A non-unique partial index SHALL serve fast lookups of the active row per topic:

```
CREATE INDEX memory_topic_key_active_idx
  ON memory(scope, project_id, topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL
```

Convergence — at most one `active` row per `(scope, project_id, topic_key)` slot — SHALL additionally be enforced by a UNIQUE partial index so the storage layer rejects a second `active` row regardless of the write path, backing the service-layer convergence guarantee (`memory` capability, upsert-by-topic-key) and the consolidation-undo guarantee (`consolidation` capability):

```
CREATE UNIQUE INDEX memory_topic_key_active_uidx
  ON memory(scope, COALESCE(project_id, ''), topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL
```

The UNIQUE index SHALL key on `COALESCE(project_id, '')`, NOT the raw `project_id` column: SQLite treats `NULL` as DISTINCT in a UNIQUE index, so a plain UNIQUE index on `(scope, project_id, topic_key)` would fail to constrain rows whose `project_id` is null. **After the global scope is retired no `memory` row carries a null `project_id`, so the `COALESCE` wrapper is defensive rather than load-bearing; it SHALL nevertheless be retained in this release** because both index definitions are pinned by the schema-drift test and rewriting them requires dropping and recreating the indexes, which is deferred with the removal of the `scope` column itself. `saveWithTopicKey` supersedes the prior active row and inserts the new one within a single transaction (supersede-then-insert order), so it never holds two active rows in a slot simultaneously and is unaffected by the constraint.

**A migration that repoints rows into a project SHALL NOT be able to violate this index, and the guarantee SHALL be structural rather than probabilistic.** The destination project is created by that same migration and therefore holds no rows, so no `(scope, project_id, topic_key)` slot in it can already be occupied; and the index already forbade two active rows sharing a `topic_key` within the retiring partition, so the migrated set is internally unique too. **This argument holds ONLY because the destination is newly created.** A migration that repointed rows into a pre-existing populated project would make every shared `topic_key` a live UNIQUE violation, so adopting an existing project as the destination SHALL NOT be done (see the `projects` capability).

The column SHALL allow any TEXT value of length ≤ 128 with no NUL bytes. The empty string SHALL be normalized to `NULL` by the service layer before insert.

The migration that introduces the UNIQUE index SHALL first heal any pre-existing duplicate-active slots (which the non-unique index permitted): for every `(scope, project_id, topic_key)` slot holding more than one `active` row, it SHALL keep the most-recently-created active row (`ORDER BY created_at DESC, id DESC`) and transition the others to `superseded` — a status flip only (append-only-safe), a no-op on a healthy database. Adding the index is index-only DDL and requires no table rebuild.

#### Scenario: Migration on an existing v0.1 database

- **WHEN** the migration adding `topic_key` is applied against a database with pre-existing rows
- **THEN** all existing rows SHALL retain `topic_key = NULL`; no backfill SHALL run

#### Scenario: Two simultaneous saves with the same topic_key (race)

- **WHEN** two `memory.save` calls with the same `(scope, project_id, topic_key)` race
- **THEN** SQLite's per-row transaction guarantees serialize them; one wins (its target is superseded), the other's candidate-detection step sees the winner as a candidate, and the response surfaces it for judgment

#### Scenario: The UNIQUE index heals pre-existing duplicate-active slots

- **GIVEN** a database in which a `(scope, project_id, topic_key)` slot holds two `active` rows R1 (older) and R2 (newer)
- **WHEN** the migration introducing the UNIQUE partial index is applied
- **THEN** R2 SHALL remain `active`, R1 SHALL be transitioned to `superseded`, and the UNIQUE index SHALL be created successfully

#### Scenario: The UNIQUE index rejects a second active row in a global slot

- **GIVEN** an `active` memory in the default project with `topic_key = K`
- **WHEN** a write attempts to add a second `active` row in that project with `topic_key = K` without superseding the incumbent
- **THEN** SQLite SHALL reject it with a UNIQUE-constraint failure
- **AND** the scenario title predates this change: the slot it names is now an ordinary project slot, and the `COALESCE(project_id, '')` key is retained as a defensive wrapper over a column that is no longer null

#### Scenario: Repointing rows into a freshly created project cannot violate the index

- **GIVEN** a populated database in which several rows in the retiring partition carry `topic_key` values also used by existing projects
- **WHEN** the migration creates a new project and repoints those rows into it
- **THEN** the UNIQUE index SHALL accept every repointed row, because the destination project held no rows before the migration

### Requirement: The server MUST log a structured startup banner with current row counts

After migrations apply and the data-loss guard passes, but BEFORE binding the HTTP listener, the server SHALL emit a structured stderr banner containing the running version, the data directory path, and the count of every operator-visible table. The banner SHALL use the prefix `[bootstrap]` for every line so operators can grep `docker compose logs rembric | grep bootstrap` to extract the startup summary.

The banner SHALL include at minimum these lines (in this order):

```
[bootstrap] rembric v<x.y.z> ready
[bootstrap] data_dir=<resolved path>
[bootstrap] counts: memory=N projects=M sessions=S tokens=T prompts=P
[bootstrap] listening on <host>:<port>
```

This makes "started with an unexpectedly empty DB" loud and obvious in operator logs, complementing the data-loss guard (which refuses to start on mass loss) by also exposing the _positive_ case ("server is up with the expected counts").

**The banner SHALL NOT restate what the migration runner has already said.** An upgrade that rewrites row partitions owes the operator a log line — an operator whose memories appear under a project they have never seen must be able to find out why — but the runner emits it, under its own `[migrate]` prefix, before and during the body (see the idempotent/crash-safe/reported requirement above). Repeating the same sentence on the banner would deliver one fact twice, byte-identically, on the same stream, and would deliver it only in the case where it is least needed: the banner runs after `createDb` returns, so it is never printed at all on the boot that was killed mid-migration.

**Which file the runner is applying is the runner's knowledge, not the migration author's**, so every applied file SHALL announce itself unconditionally rather than only when its author remembered to declare a slow step. The runner's own phases SHALL be announced too: the pre-commit `foreign_key_check` and the `COMMIT` run after the last statement, so no migration author can instrument them, and they are measured at 18.7 s and 12.5 s respectively on a 2.3 GB database — a cost every future migration pays however trivial it is.

#### Scenario: Operator sees row counts on every restart

- **WHEN** the operator runs `docker compose up -d` and then `docker compose logs --tail=20 rembric`
- **THEN** the output SHALL contain a `[bootstrap]` line listing the counts of each operator-visible table
- **AND** the operator can immediately confirm by reading the log whether the restart preserved their data

#### Scenario: Banner appears AFTER the data-loss guard

- **WHEN** the server starts and the data-loss guard refuses to start
- **THEN** the operator SHALL NOT see the `[bootstrap] listening on ...` line because the listener never binds
- **AND** the operator SHALL see the guard's error output instead, making the failure unambiguous

#### Scenario: Every applied migration announces itself, before the banner

- **WHEN** the server boots and applies at least one migration
- **THEN** each applied file SHALL have produced a `[migrate]` line naming it, and every one of those lines SHALL precede the first `[bootstrap]` line
- **AND** the runner's own `foreign_key_check` and `COMMIT` phases SHALL each have produced a line

#### Scenario: A repointing migration reports what it moved, exactly once

- **WHEN** the server boots and applies the migration that repoints previously-global rows into the default project
- **THEN** exactly one line SHALL name the default project's slug and the number of memory rows repointed, and it SHALL carry the runner's prefix rather than the banner's
- **AND** a boot on which the migration was already applied SHALL NOT repeat any of them, because nothing moved
