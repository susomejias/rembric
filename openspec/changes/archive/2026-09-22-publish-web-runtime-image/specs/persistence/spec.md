## MODIFIED Requirements

### Requirement: The distributed Docker image MUST NOT execute destructive data operations on startup

The image artifact published to `ghcr.io/susomejias/rembric:*` (and any successor registry/repository name) SHALL invoke the published runtime entrypoint (`node /app/apps/web/server.js`) on container start and SHALL NOT execute any code path that issues `DELETE FROM` against operator-visible tables (`memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, `consolidation_ops`) as part of its boot sequence.

Operator-visible tables MAY be modified by the server's normal startup path (`AgentSessionsService.abandonStale` flips `active` sessions to `abandoned` after a TTL, migration runner inserts into `_migrations`, embedding worker enqueues but does not delete) — these are non-destructive UPDATE/INSERT operations against a small subset of rows and are NOT covered by this prohibition. The prohibition specifically targets `DELETE FROM <table>` and `TRUNCATE` of any row whose loss is not deterministically reconstructible from operator action. Note that operator-invoked purge actions (session purge, archived-memory purge, deleted-prompt purge) issued via `/dashboard/maintenance` are EXEMPT — they are explicit operator intent, not boot-sequence behaviour.

The seed script `apps/server/src/scripts/seed-dev.ts` exists in the source tree and SHALL be present in the dev-stage Docker image, but SHALL NOT be invoked by the runtime-stage image's `ENTRYPOINT` or `CMD`. The published artifact is the `runner` stage of `apps/web/Dockerfile`, which ships no seed script at all — it copies only `apps/web` and `packages/*`, carries a deterministic `apps/web/package.json` for its release identity, and carries nothing from the server app. The entrypoint assertion below is kept as defence in depth: the prohibition is on the boot path, not on which files happen to be present.

Compliance with this requirement is verified by:

1. **Source-tree invariant** (`apps/web/src/test/invariants.test.ts`): assert that `apps/web/Dockerfile`'s last `FROM ... AS <name>` stage is `runner`, AND that the `runner` stage's `ENTRYPOINT` is `["/nodejs/bin/node", "/app/apps/web/server.js"]`, AND that the `runner` stage has no `CMD`. The same test file SHALL assert that `docker-publish.yml` passes `target: runner` with `dockerfile: ./apps/web/Dockerfile` and that its smoke test's expected entrypoint substring is `apps/web/server.js`, so the workflow's expectation and the Dockerfile's `ENTRYPOINT` cannot drift apart unnoticed.
2. **Publish-time smoke test** (`.github/workflows/docker-publish.yml`): after each build job pushes its per-architecture image by digest, the job SHALL pull **that digest** and inspect its `Config.Cmd`/`Config.Entrypoint`. Fail the job if either contains the substrings `seed-dev` or `tsx watch`. Fail the job if `Config.Entrypoint` does not contain `apps/web/server.js` — the entrypoint `apps/web/Dockerfile`'s `runner` stage starts, and therefore the one the published artifact must have. The retag of the immutable `:<version>`/`:sha-<short>` manifest list (and any version/major aliases) SHALL be gated on this smoke test passing on every architecture: the merge job `needs:` both build jobs.

This requirement complements the existing append-only contract on the `memory` table by closing a parallel pipeline-level gap: the runtime code is structurally append-only, but the artifact that delivers the runtime code can subvert that contract if built from the wrong source. The two layers together ensure no operator can lose data without explicitly invoking a documented destructive admin action.

#### Scenario: A correctly-published image carries the runtime entrypoint

- **WHEN** a release publishes `ghcr.io/susomejias/rembric:<version>` via `docker-publish.yml`
- **AND** the post-publish smoke test step runs
- **THEN** `docker inspect <image>` SHALL show `Config.Entrypoint` containing `node /app/apps/web/server.js`
- **AND** `Config.Cmd` SHALL NOT contain `seed-dev` or `tsx watch`
- **AND** the workflow SHALL proceed to retag `:latest` and the version/major aliases

#### Scenario: An image built from the wrong stage of `apps/server/Dockerfile` is blocked

- **GIVEN** a regression that causes `docker-publish.yml` to produce an image that does not start the web server — a mutated `CMD ["sh", "-c", "... seed-dev.ts --reset && exec tsx watch ..."]`, or a dropped web override that falls back to `apps/server/Dockerfile`
- **WHEN** the per-arch smoke test inspects the pushed digest
- **THEN** the smoke test SHALL detect `seed-dev` in `Config.Cmd` or the missing `apps/web/server.js` entrypoint
- **AND** the build job SHALL fail with a non-zero exit code BEFORE any tag is created
- **AND** no `:<version>`, `:sha-<short>`, `:latest` or alias tag SHALL be created

#### Scenario: Container start against a populated data dir preserves all rows

- **GIVEN** a properly-published runtime image is pulled and started against a bind-mounted data directory containing 50 memories across 3 projects
- **WHEN** the container starts (including a `--force-recreate` or image-version-bump scenario)
- **THEN** the server SHALL apply any pending migrations (additive only — `ALTER TABLE ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`)
- **AND** the server MAY UPDATE `sessions.status` for stale active sessions (`AgentSessionsService.abandonStale`)
- **AND** the server SHALL NOT issue `DELETE FROM` against `memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, or `consolidation_ops`
- **AND** after startup, the 50 memories and 3 projects SHALL still be present in the same numerical counts as before

#### Scenario: Invariant test enforces the rule at the source layer

- **WHEN** `apps/web/src/test/invariants.test.ts` runs the "distributed image is non-destructive" assertion
- **THEN** the test SHALL parse `apps/web/Dockerfile` and verify the `runner` stage is the last `AS <name>` stage
- **AND** verify the `runner` stage's `ENTRYPOINT` is `["/nodejs/bin/node", "/app/apps/web/server.js"]`
- **AND** verify the `runner` stage has no destructive command (no `CMD` referencing `seed-dev` or `tsx watch`)
- **AND** verify `.github/workflows/docker-publish.yml` contains a build-push step with `target: runner`
- **AND** verify `.github/workflows/docker-publish.yml` contains the post-publish smoke-test step that greps `Config.Cmd`/`Config.Entrypoint` for the forbidden substrings

#### Scenario: The invariants test allow-lists `DELETE FROM prompts` only from `purgeDeleted`

- **WHEN** the invariants test scans the source tree for `DELETE FROM prompts` occurrences
- **THEN** the only allowed occurrence SHALL be inside `packages/db/src/repositories/prompts-repository.ts::purgeDeleted` (plus the dev-only reset in `apps/web/src/scripts/seed-dev.ts`)
- **AND** the test SHALL positively assert that the allow-listed file contains the statement so the relaxation cannot silently disappear if `purgeDeleted` is removed

### Requirement: The index set MUST be exactly the measured one, and snapshot-asserted

The declared index set SHALL be exactly the measured one, and is a contract, not an accretion. Every index below was
created and its plan re-captured before it shipped; every index dropped below was
shown to be unusable by any query predicate that exists. An index no plan selects
is pure write cost.

Added by `0027_tune_hot_query_paths.sql`:

```sql
memory (scope, project_id, status, created_at)
memory (scope, project_id, type)
memory (status, created_at)
sessions (token_id, project_id, COALESCE(last_activity_at, started_at) DESC)
        WHERE status = 'active' AND deleted_at IS NULL
memory_relations (created_at)
prompts (created_at) WHERE deleted_at IS NULL
prompts (deleted_at) WHERE deleted_at IS NOT NULL
```

Two DROPs ship in the same migration because each is paired with the addition
that supersedes it, and separating them would leave the tree briefly with
neither: `memory_scope_project_status_idx` is a strict prefix of the four-column
index that replaces it, and `memory_status_last_seen_idx`'s second column served
no query — its reader filters by scope and is served by `memory_scope_seen_idx`.

Removed by `0028_drop_unusable_indexes.sql`, in a **separate migration and
commit** so a bisect can tell a removal from an addition:

```sql
confirmations_event_ts_idx
consolidation_ops_reverted_at_idx
oauth_tokens_expires_at_idx
tokens_revoked_at_idx
dashboard_sessions_token_id_idx
```

Each removal rests on a predicate argument, which is a property of the SQL rather
than of the data and therefore holds at any volume:

- `confirmations_event_ts_idx` — every reader takes `MAX(event_ts)` **inside** a `memory_id`-filtered subquery, which a bare `(event_ts)` index cannot serve. Plans re-captured with and without it: **unchanged**, and `confirmations_memory_verdict_ts_idx` serves both readers.
- `consolidation_ops_reverted_at_idx` — `reverted_at` appears only as `run_id = ? AND reverted_at IS NULL`, led by `run_id` and served by its index, and as a bare `count(reverted_at)` aggregate with no predicate at all.
- `oauth_tokens_expires_at_idx` — no query filters `oauth_tokens.expires_at`. Its predicates are `(hash, kind)`, `(id, rotated_at)` and `(family_id, revoked_at)`.
- `tokens_revoked_at_idx` — only ever `name = ? AND revoked_at IS NULL`, led by the UNIQUE index on `name`.
- `dashboard_sessions_token_id_idx` — `token_id` appears only as the join key **into** `tokens`, while the outer predicate is a `dashboard_sessions.id` primary-key lookup, so the join is driven from the other side.

**`confirmations_session_idx` was a drop candidate and SHALL be kept.** Measured
on a 50 000-session corpus, the session-content `EXISTS` selects it at 7.80 ms;
without it SQLite builds a transient automatic index and the same query costs
15.79 ms. This is the one candidate where the "unusable" hypothesis was wrong,
and it was only settled by measuring.

**Write cost of the net change, measured: unchanged.** The declared index count is
**35 before and 35 after** — 0027 is net +5 and 0028 is −5. Per-save cost
(including the FTS and `memory_replaces` triggers, the embedding insert and entity
linking for ~18 entities) measured across three runs at −11.4%, −3.1% and +1.3%: a
spread that straddles zero and is wider than any difference between the sets. The
read wins bought at no measurable write cost range from 3.7× to 6964×.

A per-save figure quoted from a single run SHALL NOT be treated as settled at this
granularity: the first run here read +6.4% and did not reproduce.

The whole set SHALL be **snapshot-asserted as an exact set**, not a subset, so an
index that exists only in migration SQL, or a declaration with no index behind
it, fails CI. Indexes Drizzle cannot express SHALL be allow-listed by name with a
reason rather than silently omitted; the allow-list is closed and adding to it is
a reviewable line.

#### Scenario: An index is added without a plan that selects it

- **WHEN** a change adds an index
- **THEN** it SHALL include the re-captured plan showing the planner selecting it for a named query
- **AND** an index no plan selects SHALL be rejected as pure write cost

#### Scenario: An index is dropped on the strength of a plan capture alone

- **WHEN** a change proposes dropping an index because it is absent from the captured plans
- **THEN** the argument SHALL additionally be a predicate argument — that no query has a predicate the index could serve — because a plan capture is evidence about the queries that exist today
- **AND** where only a plan capture is available, the drop SHALL ship in a migration separate from any addition

#### Scenario: A drop candidate turns out to be load-bearing

- **WHEN** measurement shows a candidate index is selected and its removal degrades a query
- **THEN** it SHALL be kept and the finding recorded against the candidate list
- **AND** `confirmations_session_idx` is the worked example: predicted unusable, measured at 2× on removal

#### Scenario: The declared index set diverges from the database

- **WHEN** a migration creates an index no Drizzle schema declares, or a schema declares one no migration creates
- **THEN** the exact-set snapshot assertion SHALL fail
- **AND** the fix SHALL be to reconcile the two, or to allow-list the index with the reason it is inexpressible — never to relax the assertion to a subset check

### Requirement: The `tokens` project binding MUST be closed at the database level

`tokens.scope` and `tokens.project_id` MUST encode the same fact for a project-scoped token. The foreign key from `tokens.project_id` to `projects(id)`, present since `0000_initial_tables.sql:89,93`, proves that `project_id` names a real project; nothing proves the scope string agrees with it. Two columns encoding one fact, with only one of them enforced, is a drift the next author inherits.

`tokens` SHALL carry `CHECK (project_id IS NULL OR scope = 'project:' || project_id OR scope = 'read:project:' || project_id)`, declared in the Drizzle schema as well as the migration. The constraint encodes a representational invariant — two columns must name the same project — not a tunable policy value, and so is not of the class that `0012_drop_summary_length_check.sql` retired.

Adding it costs a table rebuild, because SQLite cannot add a `CHECK` to an existing column and the column shipped without one in `0000`. The rebuild SHALL preserve every historical row **verbatim**, with no normalisation of any column. A verbatim copy is safe because every pre-existing row already satisfies the constraint by one of two arms: rows the dashboard minted carry `project_id IS NULL` and pass via the NULL arm, and rows the dev seed minted pair `project_id` with a scope string composed from that same id and pass via a matching arm. The malformed `project:<slug>` rows pass via the NULL arm, and are exactly the rows the `auth` capability requires be left inert. A row that did disagree SHALL abort the migration — the intended outcome, never a rewrite. The constraint SHALL NOT assert the converse implication (that a project-shaped scope requires a non-`NULL` `project_id`), because that form would reject exactly those legacy rows and force either an aborted migration or the forbidden rewrite; the producer-side half of that implication is bought in the service's type signature instead.

`tokens` is a foreign-key **parent** of `sessions.token_id` (`0003_sessions_and_slugs.sql:27`) and `dashboard_sessions.token_id` (`0000_initial_tables.sql:103-108`). The migration SHALL add no `foreign_keys` pragma of its own — the runner owns them, and its `PRAGMA foreign_keys = OFF` … `PRAGMA foreign_key_check` … `COMMIT` envelope is both what makes dropping a populated parent legal and what proves nothing dangled before the commit.

A `DROP TABLE` takes every index on the table with it. The rebuild SHALL recreate `tokens_name_unique`, and the redeclared `id text PRIMARY KEY NOT NULL` SHALL reinstate `sqlite_autoindex_tokens_1`. `tokens_revoked_at_idx` SHALL NOT be recreated — `0028_drop_unusable_indexes.sql` dropped it as unusable, and the index snapshot's exact-set assertion is the guard that the rebuild neither loses an index nor resurrects one.

#### Scenario: A scope string disagreeing with the project binding is rejected after the migration

- **GIVEN** two existing projects with distinct ids `X` and `Y`
- **WHEN** a row is inserted or updated with `project_id = X` and `scope = 'project:' || Y`
- **THEN** the write SHALL be rejected by the `CHECK` constraint

#### Scenario: Agreeing rows and unbound rows are accepted

- **WHEN** a row is written with `project_id = X` and `scope = 'project:' || X`, or with `project_id = X` and `scope = 'read:project:' || X`, or with `project_id IS NULL` and any scope value
- **THEN** the write SHALL be accepted

#### Scenario: The rebuild preserves history verbatim

- **GIVEN** a populated `tokens` table holding an admin `*` row, a `read:*` row, and a legacy row with `scope = 'project:<slug>'` and `project_id IS NULL`
- **WHEN** the migration runs
- **THEN** it SHALL succeed and every column of every row SHALL be unchanged, including the legacy row's malformed scope string

#### Scenario: The rebuild preserves the index set exactly

- **WHEN** the migration runs
- **THEN** `tokens_name_unique` and `sqlite_autoindex_tokens_1` SHALL be present afterwards
- **AND** no other index on `tokens` SHALL exist

#### Scenario: Dropping the FK parent does not dangle a child row

- **GIVEN** a populated `sessions` table and a populated `dashboard_sessions` table, both referencing `tokens`
- **WHEN** the migration runs
- **THEN** it SHALL commit, and the runner's pre-commit `PRAGMA foreign_key_check` SHALL report no violation

#### Scenario: A second boot re-applies nothing

- **WHEN** the server starts again against a database where the migration has already run
- **THEN** the migration SHALL NOT be re-applied and the `CHECK` SHALL remain declared exactly once
