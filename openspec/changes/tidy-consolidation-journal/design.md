## Context

The deterministic consolidation sweep (`ConsolidationRunner`) only ever calls two operation builders: `applyDecay` and `recordOrphanPromote`. Yet `consolidation/operations.ts` still exports four more — `applyMerge`, `applySupersede`, `recordNoop`, `recordFailed` — re-exported through `consolidation/index.ts` and exercised only by their own tests (verified: zero production callers; the `applySupersede` grep hits were `RelationsService.applySupersedesSideEffect`, an unrelated method). In parallel, `consolidation_runs` carries two columns, `llm_provider` / `llm_model`, that are written `NULL` by every producer (`services/{agent-sessions,prompts,memory}.ts` each pass `llmProvider: null, llmModel: null`) and rendered by a permanently-dead dashboard branch (`dashboard/consolidation.ts` guarded by `run.llmModel`). The `op_type` enum lists `archive`, which no code emits; `undoOp` treats `archive` identically to `decay` (`operations.ts:289`), strongly suggesting `decay` was once named `archive`.

The consolidation spec is protective here: it requires historical `merge` / `supersede` journal rows to keep rendering and undoing. So the cleanup is asymmetric — remove the _producers_, keep the _undo_ paths.

## Goals / Non-Goals

**Goals:** delete code and schema that the post-LLM design can no longer reach; stop writing meaningless `null` literals; guard against reintroduction; keep historical journal rows fully renderable and undoable; keep the upgrade unattended.

**Non-Goals:** changing the decay or deadline-orphaning behavior; touching `undoOp`'s `merge`/`supersede`/`orphan_promote` branches; any MCP/plugin/client change; broadening scope to the other refactors surfaced in review (data-access helpers, dashboard handler dedup) — those are separate changes.

## Decisions

### Decision 1 — Remove producers, keep undo

Delete `applyMerge`, `applySupersede`, `recordNoop`, `recordFailed` and the `MergeOpInput` / `SupersedeOpInput` types from `operations.ts`, and drop their lines from the `index.ts` barrel. Leave `undoOp` / `undoRun` and their `merge` / `supersede` branches untouched — the spec scenario "A historical LLM-era op is still visible and undoable" depends on them. This is safe because the producers can no longer create new rows of those types, but pre-upgrade rows still exist and must undo.

### Decision 2 — Removed-exports guard

No guard exists today. Add a small test (co-located with the other invariant suites under `apps/server/src/test/`) that imports the `consolidation` barrel and asserts the four producer names are NOT present as exports. This makes reintroduction a failing test rather than a silent regression, mirroring the repo's existing "invariants are sacred" posture.

### Decision 3 — Drop the `llm_*` columns via table-rebuild migration

SQLite cannot `DROP COLUMN` cleanly on older engines and these columns sit on a table with a child FK (`consolidation_ops.run_id → consolidation_runs.id`). Add `0015_drop_consolidation_llm_columns.sql` following the established rebuild precedent (`0012_drop_summary_length_check.sql`, `0014_hybrid_search_vec_rebuild.sql`): `CREATE TABLE consolidation_runs_new (…without the two columns…)` → `INSERT … SELECT (explicit column list) FROM consolidation_runs` → `DROP TABLE consolidation_runs` → `RENAME` → recreate indexes. The migration author writes NO pragmas: the runner (`db/migrate.ts`) already wraps every migration in `foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `foreign_key_check` → `COMMIT`, so dropping the FK parent is safe and dangling references abort the commit. After the migration, `NewConsolidationRun` (`$inferInsert`) no longer carries the two fields, so the three service literals and the dashboard branch are removed to satisfy the type and lint.

### Decision 4 — `archive` op_type is spike-gated

The enum trim is conditional on evidence, not assumption. A spike task queries historical/seed data for `op_type = 'archive'`. **If zero rows:** remove `archive` from the `ConsolidationOpType` union and the `op_type` enum in `db/schema/consolidation.ts`, and the two `op.opType === 'archive'` branches in `operations.ts` (collapsing the `decay`/`archive` branch to `decay`). **If any rows exist:** leave it entirely and record the count + reason in this design's Open Questions. The enum is a TS `text({ enum: [...] })` constraint, not a DB CHECK, so trimming it needs no migration — but reading a stored `archive` value would then fall outside the union, which is exactly why the spike gates it.

### Decision 5 — Tighten `scope` to NOT NULL inside the same rebuild

`consolidation_runs.scope` has been nullable since migration `0000`, but every current writer sets it (the sweep writes `scopeString(scope)`, the three purge paths write `'maintenance'`). Since we are already rebuilding the table to drop the `llm_*` columns, declare `scope` `NOT NULL` in the `_new` table for free. Legacy rows that predate scope population may hold `NULL`, so the rebuild's `INSERT … SELECT` backfills with `COALESCE(scope, 'unknown')` — `'unknown'` is an inert sentinel the dashboard already tolerates as an arbitrary scope string. This is the canonical "tighten while you rebuild" win and adds no extra migration.

### Decision 6 — Rename `consolidation_ops.consolidation_id` → `run_id`

The column is a foreign key onto `consolidation_runs.id` — i.e. a _run_ id — yet it is named `consolidation_id`, which reads as "the id of a consolidation." The decisive signal: every consumer already binds it to a variable named `runId` (`listActiveOps(runId)`, `eq(consolidationOps.consolidationId, runId)`, the `runId` arg threaded through `operations.ts`/`runner.ts`/the services). The column name is the only thing out of step. SQLite supports `ALTER TABLE consolidation_ops RENAME COLUMN consolidation_id TO run_id` (3.25+), so this is a cheap rename, **not** a rebuild, and is independent of the `consolidation_runs` rebuild — they ship in the same migration file for atomicity but touch different tables. The code change is a mechanical rename of ~20 references: the Drizzle field (`consolidationId`→`runId`), the index name (`consolidation_ops_consolidation_id_idx`→`consolidation_ops_run_id_idx`, recreated in the migration), and every call site. No behavior changes.

### Decision 7 — Fix stale LLM-era comments

Two comments are now lies: the schema-file docstring says "Audit and reversal journal for the consolidation consolidation" (duplicated word), and the `reasoning` column says "Free-form LLM reasoning attached for auditability" — there is no LLM; `reasoning` now holds a deterministic string built by the sweep. Correct both. Comment-only; no contract impact. Keeps the file honest for the next reader (per the CLAUDE.md comment-discipline rule: a comment must document a true non-obvious fact).

## Risks / Trade-offs

- **Migration on a parent FK table** → mitigated by the runner's FK-safety dance + the `foreign_key_check` pre-commit gate; covered by an upgrade test asserting row preservation (new spec scenario).
- **Spec narrows "no DB migration" guarantee** → acceptable: the guarantee that actually matters to operators ("zero manual steps") is preserved and re-stated; the migration is unattended. Captured in the `consolidation` delta.
- **Trimming `archive` could orphan an old stored value** → fully mitigated by the spike gate (Decision 4); we do not trim without proof of zero rows.
- **Dropping producers could break an out-of-tree caller** → none exist in this repo; the new guard test formalizes the removal.
- **`scope` NOT NULL on legacy NULL rows** → mitigated by the `COALESCE(scope, 'unknown')` backfill in the rebuild SELECT; the `foreign_key_check` and a row-count assertion in the upgrade test confirm no data loss.
- **Wide `run_id` rename touching many call sites** → purely mechanical; typecheck + lint + the full suite catch any missed reference, and the rename carries no behavior change.

## Migration Plan

1. Land producer removal + barrel edit + guard test (no schema impact).
2. Land `0015` migration + remove the three `null` literals + dashboard branch together (they must move with `$inferInsert`). The single migration file does both table operations: the `consolidation_runs` rebuild (drop `llm_*`, `scope` NOT NULL + `COALESCE` backfill, recreate `consolidation_runs_started_at_idx`) and the `consolidation_ops` `RENAME COLUMN consolidation_id TO run_id` (+ recreate the renamed index). The migration author writes no pragmas — `db/migrate.ts` wraps the body in the FK-safety dance.
3. Land the `runId` code rename across schema/repo/operations/runner/services/dashboard (mechanical).
4. Run the spike; apply the `archive` trim only if clean.
5. Fix the two stale comments.
   Forward-only. Rollback = revert the commits; the dropped columns can be re-added and the column re-renamed by a follow-up migration if ever needed (they held no data; the rename is reversible).

## Open Questions

- Spike result for `op_type = 'archive'`: **zero**. No producer exists anywhere (code/seed/fixtures/SQL — it appeared only in the enum definition and the two `undoOp` branches), and the spec's own historical-op list (merge/supersede/orphan*promote) excludes it. No queryable DB held `archive` rows. The enum trim shipped in this change. \_Caveat:* a live production DB could not be queried from this environment; if any such DB ever wrote an `archive` row, reading it would fall outside the trimmed TS union (text column, so no crash) and its undo would no-op — considered acceptable given the total absence of a producer in git history.
