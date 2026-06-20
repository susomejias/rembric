## Why

When the LLM consolidator was removed (`remove-llm-consolidation`), the deterministic sweep stayed but a layer of LLM-era residue was never cleaned up, and the consolidation journal schema accumulated naming/nullability debt. Because dropping the dead `llm_*` columns already forces a table-rebuild of `consolidation_runs`, this change folds in the adjacent schema tidy-ups that the rebuild makes cheap, so the consolidation journal is left symmetric and honest in one pass: four unreachable op producers, two always-`NULL` columns, a never-emitted enum member, a nullable-but-always-written `scope` column, a misnamed foreign-key column (`consolidation_id` pointing at a _run_), and stale LLM-era comments.

## What Changes

- **Remove the dead op producers.** Delete `applyMerge`, `applySupersede`, `recordNoop`, `recordFailed` (and the `MergeOpInput` / `SupersedeOpInput` types) from `consolidation/operations.ts` and their re-exports in `consolidation/index.ts`. The deterministic sweep only ever calls `applyDecay` and `recordOrphanPromote`; the spec already mandates the sweep "SHALL NOT produce new rows of those types."
- **Keep `undoOp` history support.** The `merge` / `supersede` branches in `undoOp`/`undoRun` stay so pre-upgrade journal rows remain renderable and undoable.
- **Add a removed-exports guard** test that fails if any of the four producers is reintroduced as an export — none exists today.
- **BREAKING (internal schema): drop the vestigial columns.** Drop `llm_provider` and `llm_model` from `consolidation_runs` via a SQLite table-rebuild migration (per the CLAUDE.md migration dance). Remove the three `llmProvider: null, llmModel: null` literals (`services/{agent-sessions,prompts,memory}.ts`) and the dead `run.llmModel` branch in `dashboard/consolidation.ts`.
- **Tighten `consolidation_runs.scope` to `NOT NULL`.** It is nullable from migration `0000` but is now always written (sweep writes the scope string, purges write `'maintenance'`). The same rebuild makes this free; any legacy `NULL` row is backfilled with `'unknown'` in the `INSERT … SELECT`.
- **Rename `consolidation_ops.consolidation_id` → `run_id`.** The column references `consolidation_runs.id` (a _run_); every consumer already names the variable `runId`. Cheap `ALTER TABLE … RENAME COLUMN` (no rebuild) plus a mechanical rename across ~20 references (schema, repository, `operations.ts`, `runner.ts`, the three services, dashboard, the index).
- **Fix stale comments.** The schema docstring typo ("consolidation consolidation") and the `reasoning` column comment ("Free-form LLM reasoning" — there is no LLM anymore; it is a deterministic string).
- **Spike, then decide on `op_type = 'archive'`.** Confirm against historical journal/seed data that no `consolidation_ops` row uses `op_type = 'archive'`. If zero rows, remove `archive` from the enum and the `undoOp` branch; if any exist, leave it and document why.

This change removes only LLM-era residue and tightens journal schema hygiene. All live behavior (decay, deadline orphaning, journaling, reversibility of historical rows) is preserved.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `consolidation`: the requirement "Removed configuration MUST degrade gracefully on upgrade" currently states upgrades require **no DB migration** — this change introduces one automatic migration (column drop + `scope` tighten + FK column rename), so that guarantee is narrowed to "no manual steps" rather than "no migration." The scenario "First session start after the throttle window triggers a sweep" currently asserts the new `consolidation_runs` row has `llm_provider`/`llm_model` `NULL`; that assertion is removed because the columns cease to exist. (The `scope` nullability and the `consolidation_id`→`run_id` rename are not referenced by any spec requirement, so they need no further delta.)
- `dashboard`: the requirement "Consolidation runs MUST be inspectable and reversible from the dashboard" mandated a `llm_model`-based model indicator on the run detail (plus the "Legacy LLM run keeps its provenance visible" / "Sweep run renders no model indicator" scenarios). Dropping the `llm_model` column removes that capability, so the model-indicator clause and both scenarios are deleted; all other dashboard consolidation behavior is unchanged.

## Impact

- **Code:** `apps/server/src/consolidation/{operations.ts,index.ts,runner.ts}`; `apps/server/src/db/schema/consolidation.ts` (drop two columns; `scope` NOT NULL; rename `consolidationId`→`runId`; conditional enum trim; comment fixes); `apps/server/src/db/repositories/consolidation-repository.ts` (`insertRun` shape follows `$inferInsert`; `runId` rename); `apps/server/src/services/{agent-sessions,prompts,memory}.ts` (drop the `null` literals; `consolidationId`→`runId`); `apps/server/src/dashboard/consolidation.ts` (drop dead branch; `op.consolidationId`→`op.runId`).
- **Migration:** one new migration under `apps/server/src/db/migrations/` — table-rebuild of `consolidation_runs` (drop `llm_*`, `scope` NOT NULL with `'unknown'` backfill) plus `RENAME COLUMN consolidation_id TO run_id` on `consolidation_ops` and the matching index recreation. Runs automatically on boot; no operator action.
- **Spec:** `openspec/specs/consolidation/spec.md` — two requirement edits (delta in this change).
- **Tests:** update `consolidation/operations.test.ts` and `consolidation/runner.test.ts`; add the removed-exports guard; `schema-drift.test.ts` reflects the new column set and names.
- **Compatibility:** historical `merge`/`supersede` journal rows keep rendering and undoing. The migration is forward-only and preserves all rows. No plugin/client changes; no MCP tool changes. Server-only.
