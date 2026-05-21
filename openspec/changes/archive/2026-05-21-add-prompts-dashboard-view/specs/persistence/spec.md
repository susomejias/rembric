## ADDED Requirements

### Requirement: The `prompts` table MUST carry lifecycle and retrieval metadata columns

The `prompts` schema SHALL be extended with the following nullable columns, all added via a single additive migration (`ALTER TABLE prompts ADD COLUMN <col>`):

- `deleted_at INTEGER` (timestamp_ms, nullable) — operator soft-delete marker. NULL = visible; non-NULL = soft-deleted.
- `title TEXT` (nullable, ≤100 chars enforced at the application layer) — short human-readable label for retrieval lists.
- `tags TEXT` (nullable, JSON array of strings) — categorical labels; same shape as `memory.tags`.
- `replaces TEXT` (nullable, JSON array of prompt IDs) — predecessor link for the refine chain (typically a single-element array of the previous prompt's id, mirroring the shape of `memory.replaces`).

The `content` column SHALL remain immutable in convention — there SHALL be no UPDATE-capable code path for it. Lifecycle changes SHALL be expressed via `deleted_at` flips (operator or refine) plus the `replaces` link (refine).

Existing rows SHALL get NULL for all four new columns at migration time. No backfill is required.

#### Scenario: Schema review confirms the new columns and their immutability contract

- **WHEN** a code reviewer inspects `apps/server/src/db/schema/prompts.ts`
- **THEN** the schema SHALL declare `deleted_at`, `title`, `tags`, `replaces` as nullable columns
- **AND** the file's top-level docstring SHALL describe `content` as immutable; lifecycle as `deleted_at` flips + `replaces` links

#### Scenario: Existing prompts survive the migration with NULL metadata

- **GIVEN** a DB with prompts inserted before this change
- **WHEN** the migration runs
- **THEN** every pre-existing row SHALL gain `deleted_at = NULL`, `title = NULL`, `tags = NULL`, `replaces = NULL`
- **AND** the row's `content`, `session_id`, `project_id`, `agent`, `created_at` SHALL remain unchanged

### Requirement: `prompts_fts` MUST stay in sync with `prompts`

The persistence layer SHALL gain a contentless FTS5 virtual table `prompts_fts` indexing `content` plus a flattened tags string, configured with `content='prompts'` and `content_rowid='rowid'`. The table SHALL be maintained automatically by three triggers on `prompts`:

- `prompts_ai` (`AFTER INSERT`): inserts a row into `prompts_fts` with the new `content` and `coalesce(group_concat(value, ' ') FROM json_each(new.tags), '')`.
- `prompts_au` (`AFTER UPDATE`): emits a `'delete'` row to `prompts_fts` for the old values, then inserts a fresh row with the new values. This trigger is required because `deleted_at` and `replaces` flips are UPDATEs on the `prompts` row even though `content` itself never changes.
- `prompts_ad` (`AFTER DELETE`): emits a `'delete'` row to `prompts_fts` for the old values. This trigger is defensive — `DELETE FROM prompts` only happens through `PromptsService.purgeDeleted` — but kept consistent with the `memory_fts` pattern.

The triggers SHALL be installed by a dedicated migration `apps/server/src/db/migrations/000X_prompts_fts.sql`. The migration SHALL also backfill `prompts_fts` from existing rows so the index is complete on first boot after this change.

#### Scenario: Inserting a prompt populates prompts_fts immediately

- **WHEN** a row is inserted into `prompts` with `content = "deploy via Docker Compose"` and `tags = '["deploy","docker"]'`
- **THEN** a corresponding row SHALL exist in `prompts_fts` indexing both `"deploy via Docker Compose"` and the flattened `"deploy docker"` string before the transaction commits

#### Scenario: Soft-deleting a prompt updates prompts_fts via the AU trigger

- **GIVEN** prompt P1 indexed in `prompts_fts`
- **WHEN** the dashboard sets `P1.deleted_at = now()`
- **THEN** the `prompts_au` trigger SHALL re-issue the index entry (delete-then-insert) so the row remains discoverable when callers pass `includeDeleted: true`
- **AND** queries with `includeDeleted: false` SHALL filter out P1 at the outer-table level, not via the index

#### Scenario: Refining a prompt updates prompts_fts for both the old and the new row

- **GIVEN** prompt P1 in scope
- **WHEN** the agent calls `memory.save_prompt({ content: "...refined...", replaces: "<P1.id>" })`
- **THEN** P1's index entry SHALL be re-issued by the `prompts_au` trigger (because `P1.deleted_at` flipped)
- **AND** a new index entry SHALL be inserted for P2 by the `prompts_ai` trigger

#### Scenario: Physically purging a prompt removes its prompts_fts row

- **GIVEN** prompt P1 with `deleted_at IS NOT NULL`
- **WHEN** `PromptsService.purgeDeleted({ adminBypass: true })` deletes P1 from `prompts`
- **THEN** the `prompts_ad` trigger SHALL emit a `'delete'` row to `prompts_fts` so the index entry is removed in the same transaction

### Requirement: `prompts` MUST be physically purgeable when soft-deleted

A `prompts` row SHALL be physically deletable from the `prompts` table ONLY through `PromptsService.purgeDeleted({ adminBypass: true })` and ONLY when the row's `deleted_at IS NOT NULL`. The method SHALL be the sole code path that issues `DELETE FROM prompts`; the invariant test (`apps/server/src/test/invariants.test.ts`) SHALL allow-list this call site explicitly and SHALL positively assert that the file actually contains the `DELETE FROM prompts` statement (so the relaxation cannot expire silently if the implementation drifts).

The method SHALL run the predicate and the DELETE inside a single SQLite transaction. The method SHALL write a `consolidation_ops` row with `op_type = 'prompt_purge'`, `affected_ids` carrying the deleted ids, and a static `reasoning` string, in the same transaction. The `prompts_ad` trigger SHALL cascade-remove the corresponding `prompts_fts` entries inside the same transaction.

Without `adminBypass: true`, the method SHALL throw `DomainError('forbidden', ...)` and SHALL NOT touch the database.

#### Scenario: Soft-deleted prompts are purged and journaled

- **GIVEN** 4 prompts with `deleted_at IS NOT NULL` exist
- **WHEN** `PromptsService.purgeDeleted({ adminBypass: true })` is called
- **THEN** the 4 rows SHALL be removed from `prompts`
- **AND** the matching 4 rows SHALL be removed from `prompts_fts` (via the AFTER DELETE trigger)
- **AND** a `consolidation_ops` row SHALL exist with `op_type = 'prompt_purge'` and `affected_ids` of length 4
- **AND** the response SHALL include the 4 ids in `deletedIds`

#### Scenario: A non-admin caller is rejected before any read

- **WHEN** `PromptsService.purgeDeleted({})` or `purgeDeleted({ adminBypass: false })` is called
- **THEN** the method SHALL throw `DomainError('forbidden', ...)`
- **AND** SHALL NOT issue any SQL statement

#### Scenario: A prompt without `deleted_at` is not purged

- **GIVEN** prompts `P1` (`deleted_at = NULL`) and `P2` (`deleted_at = now − 1h`)
- **WHEN** `PromptsService.purgeDeleted({ adminBypass: true })` is called
- **THEN** `P2` SHALL be removed and `P1` SHALL remain
- **AND** the response's `deletedIds` SHALL contain only `P2.id`

#### Scenario: `consolidation_ops` row from prompt purge is never deletable

- **GIVEN** `purgeDeleted` has run and produced a `consolidation_ops` row with `op_type='prompt_purge'`
- **WHEN** any subsequent purge runs (sessions, memories, or prompts) or the consolidator runs
- **THEN** the `consolidation_ops` row SHALL remain in place, preserving the audit trail of which prompt ids were physically removed and when

## MODIFIED Requirements

### Requirement: The distributed Docker image MUST NOT execute destructive data operations on startup

The image artifact published to `ghcr.io/susomejias/rembric:*` (and any successor registry/repository name) SHALL invoke the runtime server entrypoint (`node /app/dist/server-entrypoint.js`) on container start and SHALL NOT execute any code path that issues `DELETE FROM` against operator-visible tables (`memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, `consolidation_ops`) as part of its boot sequence.

Operator-visible tables MAY be modified by the server's normal startup path (`AgentSessionsService.abandonStale` flips `active` sessions to `abandoned` after a TTL, migration runner inserts into `_migrations`, embedding worker enqueues but does not delete) — these are non-destructive UPDATE/INSERT operations against a small subset of rows and are NOT covered by this prohibition. The prohibition specifically targets `DELETE FROM <table>` and `TRUNCATE` of any row whose loss is not deterministically reconstructible from operator action. Note that operator-invoked purge actions (session purge, archived-memory purge, deleted-prompt purge) issued via `/dashboard/maintenance` are EXEMPT — they are explicit operator intent, not boot-sequence behaviour.

The seed script `apps/server/src/scripts/seed-dev.ts` exists in the source tree and SHALL be present in the dev-stage Docker image, but SHALL NOT be invoked by the runtime-stage image's `ENTRYPOINT` or `CMD`. Compliance with this requirement is verified by:

1. **Source-tree invariant** (`apps/server/src/test/invariants.test.ts`): assert that `apps/server/Dockerfile`'s last `FROM ... AS <name>` stage is `runtime`, AND that the runtime stage's `ENTRYPOINT` is `["node", "/app/dist/server-entrypoint.js"]`, AND that the runtime stage has no `CMD` (or only an empty `CMD []`).
2. **Publish-time smoke test** (`.github/workflows/docker-publish.yml`): after `docker push`, pull the just-pushed immutable `:sha-<short>` tag and inspect its `Config.Cmd`/`Config.Entrypoint`. Fail the workflow if either contains the substrings `seed-dev` or `tsx watch`. Fail if `Config.Entrypoint` is empty and `Config.Cmd` does not contain `dist/server-entrypoint.js`. The retag of `:latest` (and any version/major aliases) SHALL be gated on this smoke test passing.

This requirement complements the existing append-only contract on the `memory` table by closing a parallel pipeline-level gap: the runtime code is structurally append-only, but the artifact that delivers the runtime code can subvert that contract if built from the wrong source. The two layers together ensure no operator can lose data without explicitly invoking a documented destructive admin action.

#### Scenario: A correctly-published image carries the runtime entrypoint

- **WHEN** a release publishes `ghcr.io/susomejias/rembric:<version>` via `docker-publish.yml`
- **AND** the post-publish smoke test step runs
- **THEN** `docker inspect <image>` SHALL show `Config.Entrypoint` containing `node /app/dist/server-entrypoint.js`
- **AND** `Config.Cmd` SHALL NOT contain `seed-dev` or `tsx watch`
- **AND** the workflow SHALL proceed to retag `:latest` and the version/major aliases

#### Scenario: An image built from the wrong stage of `apps/server/Dockerfile` is blocked

- **GIVEN** a regression that causes `docker-publish.yml` to produce an image with `CMD ["sh", "-c", "... seed-dev.ts --reset && exec tsx watch ..."]`
- **WHEN** the post-publish smoke test inspects the pushed `:sha-<short>` tag
- **THEN** the smoke test SHALL detect `seed-dev` in `Config.Cmd`
- **AND** the workflow SHALL fail with a non-zero exit code BEFORE retagging `:latest`
- **AND** the `:sha-<short>` immutable tag remains in the registry but is NEVER promoted to `:latest`

#### Scenario: Container start against a populated data dir preserves all rows

- **GIVEN** a properly-published runtime image is pulled and started against a bind-mounted data directory containing 50 memories across 3 projects
- **WHEN** the container starts (including a `--force-recreate` or image-version-bump scenario)
- **THEN** the server SHALL apply any pending migrations (additive only — `ALTER TABLE ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`)
- **AND** the server MAY UPDATE `sessions.status` for stale active sessions (`AgentSessionsService.abandonStale`)
- **AND** the server SHALL NOT issue `DELETE FROM` against `memory`, `projects`, `sessions`, `tokens`, `prompts`, `memory_relations`, `confirmations`, or `consolidation_ops`
- **AND** after startup, the 50 memories and 3 projects SHALL still be present in the same numerical counts as before

#### Scenario: Invariant test enforces the rule at the source layer

- **WHEN** `apps/server/src/test/invariants.test.ts` runs the "distributed image is non-destructive" assertion
- **THEN** the test SHALL parse `apps/server/Dockerfile` and verify the `runtime` stage is the last `AS <name>` stage
- **AND** verify the `runtime` stage's `ENTRYPOINT` is `["node", "/app/dist/server-entrypoint.js"]`
- **AND** verify the `runtime` stage has no destructive command (no `CMD` referencing `seed-dev` or `tsx watch`)
- **AND** verify `.github/workflows/docker-publish.yml` contains a build-push step with `target: runtime`
- **AND** verify `.github/workflows/docker-publish.yml` contains the post-publish smoke-test step that greps `Config.Cmd`/`Config.Entrypoint` for the forbidden substrings

#### Scenario: The invariants test allow-lists `DELETE FROM prompts` only from `purgeDeleted`

- **WHEN** the invariants test scans the server source tree for `DELETE FROM prompts` occurrences
- **THEN** the only allowed occurrence SHALL be inside `apps/server/src/services/prompts.ts::purgeDeleted`
- **AND** the test SHALL positively assert that file contains the statement so the relaxation cannot silently disappear if `purgeDeleted` is removed
