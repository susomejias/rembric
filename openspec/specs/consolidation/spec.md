# consolidation Specification

## Purpose

Defines the deterministic consolidation sweep that resolves memory pollution (decay and aged-pending orphaning) while preserving append-only semantics, scope isolation, journaling, and reversibility.

## Requirements

### Requirement: The consolidation sweep MUST run lazily on session start, throttled per scope

The server SHALL run the deterministic consolidation sweep (decay + deadline orphaning + empty-session purge) as a side effect of session creation — both `POST /api/sessions` / `POST /api/<slug>/sessions` and MCP `memory.session_start` SHALL funnel through the same service method. The sweep SHALL be throttled: it SHALL short-circuit when the most recent `consolidation_runs` row for the target scope is younger than the internal minimum interval (24h). Sweep execution SHALL happen off the request's critical path: a sweep failure SHALL be logged and SHALL NOT fail the session call. A manually triggered run via `POST /admin/consolidation/run` (or the dashboard equivalent) SHALL remain possible at any time and SHALL bypass the throttle.

**A session start SHALL sweep its own project AND the default project.** The sweep previously included the global scope unconditionally, on the reasoning that global hygiene would otherwise starve because every session-registering path is project-scoped. That reasoning does not stop applying when the global scope is retired — it transfers verbatim to the default project, whose rows are precisely the ones the retiring migration moved there. A default project that is only swept when someone opens a session in it would accumulate exactly the un-decayed corpus this mechanism exists to prevent, and the memories affected would be the migrated ones. The second scope SHALL therefore be the default project, resolved from `is_default`, not a hardcoded scope literal.

The sweep's empty-session purge step SHALL invoke `AgentSessionsService.purgeEmpty` — the same method already reachable manually from `/dashboard/maintenance` — using the session capability's `sessionHasContent` predicate to decide eligibility. It SHALL introduce no new scheduling primitive, admin-bypass surface, or throttle beyond the sweep's own; a purge performed this way SHALL journal to `consolidation_ops` identically to a manually-triggered one.

**The empty-session purge SHALL be triggered by the default project's run, not by a global run.** Its condition was previously "a global-scope run happened in this sweep", which becomes permanently false once no run is global — and the failure is silent: no counter moves, no warning fires, and empty sessions simply accumulate forever. The condition SHALL be re-anchored on the run for the default project, which every session start includes, so the purge fires on the same cadence it does today. A test SHALL assert a **non-zero** purge count, because a purge assertion over a corpus with nothing eligible passes without exercising anything.

#### Scenario: First session start after the throttle window triggers a sweep

- **GIVEN** the newest `consolidation_runs` row for the scope is older than the minimum interval (or absent)
- **WHEN** a session is started in that scope
- **THEN** the sweep SHALL run for that scope and a new `consolidation_runs` row SHALL be created with `started_at` set

#### Scenario: Session start within the throttle window skips the sweep

- **GIVEN** a `consolidation_runs` row for the scope younger than the minimum interval
- **WHEN** a session is started in that scope
- **THEN** no sweep SHALL run and no new `consolidation_runs` row SHALL be created

#### Scenario: Sweep failure does not break session start

- **WHEN** the sweep throws after a session has been created
- **THEN** the session call SHALL still succeed and the failure SHALL be logged

#### Scenario: Manual run bypasses the throttle

- **WHEN** an operator submits `POST /admin/consolidation/run` with a valid admin bearer token
- **THEN** the sweep SHALL execute immediately regardless of the throttle and SHALL produce a `consolidation_runs` row

#### Scenario: A noise session is purged automatically without operator action

- **GIVEN** a session `S` that fails `sessionHasContent` (a raw uncurated summary and nothing else anchored to it) and is older than the existing purge-eligibility age floor
- **WHEN** the consolidation sweep next runs for `S`'s scope, subject to the existing throttle
- **THEN** `S` SHALL be physically deleted by the same code path `purgeEmpty` already uses when triggered manually
- **AND** a `consolidation_ops` row SHALL record the purge, identical in shape to a manually-triggered one

#### Scenario: The manual dashboard trigger is unaffected

- **WHEN** an operator clicks the existing purge button on `/dashboard/maintenance`
- **THEN** behavior SHALL be unchanged — this requirement only adds an additional, automatic invocation site inside the existing sweep

#### Scenario: A session start in one project also sweeps the default project

- **GIVEN** a project `alpha` and the default project, both outside the throttle window
- **WHEN** a session is started in `alpha`
- **THEN** the sweep SHALL produce a `consolidation_runs` row for `alpha` AND one for the default project
- **AND** the default project's decay work SHALL be performed, so a memory in it that has crossed its decay threshold SHALL be archived

#### Scenario: The empty-session purge still fires

- **GIVEN** at least one session eligible for `purgeEmpty` and a session start in any project outside the throttle window
- **WHEN** the sweep runs
- **THEN** `purgeEmpty` SHALL be invoked and its deleted-id count SHALL be greater than zero
- **AND** the trigger SHALL be the default project's run rather than any condition on a global scope, so it cannot become permanently false

#### Scenario: A migration that retargets a live run writes the scope string readers parse

- **GIVEN** an unfinished `consolidation_runs` row whose scope is being moved from the retiring scope onto the default project
- **WHEN** the migration rewrites it
- **THEN** the value SHALL be the `project:<id>` form every reader parses — the throttle lookup, the dashboard's scope cell, and the run-detail label — and SHALL NOT be a bare project id
- **AND** a bare id SHALL be shown to satisfy none of them: the throttle would not find the row, and the operator surface would render opaque hex where it is required to render the project's slug

### Requirement: Aged pending relations MUST be deterministically orphaned after a deadline

A `memory_relations` row with `status = 'pending'` and `created_at < (now - JUDGMENT_ORPHAN_DEADLINE_MS)` (default 14 days) SHALL be transitioned to `status = 'orphaned'` by the sweep, with `marked_by_kind = 'consolidator'`. Each orphaning SHALL be journaled in `consolidation_ops` and SHALL be undoable while the referenced rows exist. No LLM SHALL be involved. Between `JUDGMENT_ORPHAN_AFTER_MS` (default 24h) and the deadline, the pending row SHALL be surfaced to agents via `memory.context` (see `mcp-api` capability) so it can be closed with `memory.judge` under fresh context — UNLESS either of its endpoints has left `active`, in which case the `memory` capability withholds it from that queue ("A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). The withholding does NOT exempt the row from this requirement: the sweep's own selection ignores endpoint lifecycle, so a withheld row still reaches `orphaned` at the deadline. A row invisible to the agent AND invisible to the sweep would be immortal, which is why exactly one of the two reads filters.

The orphaning pass SHALL select its candidates with a query scoped to the swept scope (the scope filter applied in SQL, oldest-first, bounded by the per-run batch size). Rows belonging to other scopes SHALL NOT consume the swept scope's batch budget, so a backlog in one scope cannot starve another scope's overdue pendings.

#### Scenario: A pending relation crosses the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs for its scope
- **THEN** the row SHALL transition to `status = 'orphaned'` and a journaled op SHALL record it; the orphaned status is final unless a future `memory.judge` or `memory.compare` call writes a fresh row

#### Scenario: A pending relation is between the re-expose threshold and the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_AFTER_MS` but younger than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs
- **THEN** the row SHALL remain `pending` (only `memory.context` exposure applies, and only while both endpoints are `active`)

#### Scenario: A retired-endpoint row is withheld from the agent but still orphaned

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_DEADLINE_MS` whose source was superseded by a `topic_key` revision
- **WHEN** the sweep runs for its scope
- **THEN** the row SHALL transition to `status = 'orphaned'` with a journaled op, exactly as if both endpoints were still `active`
- **AND** the sweep's candidate selection SHALL NOT apply the agent queue's endpoint-lifecycle filter

#### Scenario: A large backlog in one scope does not starve another

- **GIVEN** project A has more overdue pending relations than the per-run batch size and project B has one overdue pending relation
- **WHEN** the sweep runs for project B
- **THEN** project B's overdue row SHALL be orphaned in that run, regardless of project A's backlog

### Requirement: Removed configuration MUST degrade gracefully on upgrade

A server booting in an environment that still defines any removed variable (`LLM_PROVIDER`, `OPENAI_MODEL`, `CONSOLIDATION_ENABLED`, `CONSOLIDATION_CRON`, `CONSOLIDATION_BATCH_SIZE`) SHALL start normally and SHALL log a single warning naming the ignored variables. `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL` and `EMBEDDING_*` remain valid (embedding client). Boot SHALL NOT fail on a missing `OPENAI_API_KEY` under any combination. Upgrading a running installation SHALL require zero manual operator steps: no config rewrite and no plugin update. The boot-time migration runner MAY apply schema migrations automatically (including dropping the obsolete `consolidation_runs.llm_provider` / `llm_model` columns); such migrations SHALL run unattended, SHALL preserve all existing `consolidation_runs` / `consolidation_ops` rows, and SHALL NOT require any operator action.

#### Scenario: Boot with stale LLM env vars

- **WHEN** the server boots with `OPENAI_MODEL` and `CONSOLIDATION_CRON` still set
- **THEN** it SHALL reach the listening state and SHALL log one warning listing both names as ignored

#### Scenario: Upgrade boot applies the column-drop migration unattended

- **GIVEN** a database whose `consolidation_runs` table still has the `llm_provider` / `llm_model` columns and contains existing run and op rows
- **WHEN** the server boots after the upgrade
- **THEN** the migration runner SHALL rebuild `consolidation_runs` without those two columns, all pre-existing `consolidation_runs` and `consolidation_ops` rows (including historical `merge` / `supersede` ops) SHALL be preserved, and no operator action SHALL be required

### Requirement: The consolidation MUST target redundancy, drift, contradiction, and decay

The consolidation sweep SHALL perform exactly two passes per run: (1) decay (deterministic, no LLM), and (2) deadline orphaning of pending relations older than `JUDGMENT_ORPHAN_DEADLINE_MS`. The LLM-driven detection of redundancy / drift / contradiction over the full corpus is REMOVED — that work moves to save-time as `memory.save` candidate detection. The LLM judging of aged pending relations is REMOVED — aged pendings are re-exposed to agents via `memory.context` and deterministically orphaned at the deadline.

The decay pass SHALL select candidates using a static per-type `last_seen_at` threshold: a memory of type `T` is a decay candidate when it is `active`, its confirmation count is below the confidence floor, and its `last_seen_at` is older than the threshold configured for `T`. The thresholds SHALL be a static in-code map keyed by `MemoryType` with a single default fallback threshold applied to any type lacking an explicit entry; the map SHALL NOT be operator-configurable and SHALL NOT be derived from the review axis. The decay axis SHALL remain keyed on `last_seen_at` plus the confidence floor only; it SHALL NOT read `created_at`, confirmation baselines, or `REVIEW_TTL_MS`. The decay and review axes SHALL remain orthogonal: making the decay threshold vary by type SHALL NOT couple the two axes. No LLM and no cron SHALL be involved in selecting decay candidates.

#### Scenario: A memory has not been seen for longer than its type's decay threshold

- **GIVEN** a memory whose `last_seen_at` is older than the decay threshold configured for its `type` and whose `confidence` count is below the floor
- **WHEN** the sweep runs
- **THEN** the memory SHALL transition from `active` to `archived` without an LLM call

#### Scenario: Two memories of different types pass the same last_seen_at point

- **GIVEN** two `active` memories with identical `last_seen_at` and confidence below the floor, one of a type with a SHORT decay threshold and one of a type with a LONGER decay threshold, and `now` such that only the short threshold has elapsed
- **WHEN** the sweep runs
- **THEN** the short-threshold memory SHALL be archived and the longer-threshold memory SHALL remain `active`

#### Scenario: A type without an explicit threshold uses the default fallback

- **GIVEN** a memory of a type that has no explicit entry in the per-type decay map
- **WHEN** the sweep evaluates it for decay
- **THEN** the default fallback threshold SHALL be applied to that memory, so its decay behavior is identical to the prior single global threshold

#### Scenario: Changing a type's decay threshold does not affect its review state

- **GIVEN** the per-type decay threshold for a type is changed in the static map
- **WHEN** review state is derived for a memory of that type
- **THEN** the derived `reviewState` / `reviewAfter` SHALL be unchanged, because review is keyed on `created_at` plus confirmation baseline plus `REVIEW_TTL_MS` and is orthogonal to the decay threshold

#### Scenario: Two near-duplicate memories save apart from each other

- **GIVEN** the second save's candidate detection found the first as a candidate
- **WHEN** that save returned `candidates: [{...}]` and the agent never called `memory.judge`
- **THEN** after `JUDGMENT_ORPHAN_AFTER_MS` the pending relation SHALL appear in `memory.context.pendingJudgments[]`, and after `JUDGMENT_ORPHAN_DEADLINE_MS` without judgment the sweep SHALL orphan it — no LLM is invoked at any point

### Requirement: Consolidation operations MUST be atomic per operation

Each operation in a consolidation run SHALL be applied within a single SQLite transaction. If any part of the operation fails, the transaction SHALL be rolled back and the operation SHALL be recorded as failed in `consolidation_ops` with the error reason.

#### Scenario: Failure mid-merge

- **GIVEN** a merge operation has inserted a new merged memory but the predecessor status update fails
- **WHEN** the transaction commit is attempted
- **THEN** the transaction SHALL roll back, the merged memory SHALL NOT exist after rollback, the predecessors SHALL remain `active`, and a failed op SHALL be logged

### Requirement: Consolidation MUST NEVER cross scope boundaries

The consolidation SHALL operate one project at a time. A single consolidation op SHALL NOT touch memories belonging to more than one project. The default project is an ordinary project for this purpose and confers no cross-project reach.

#### Scenario: Two memories of different projects look similar

- **GIVEN** memory X with `project_id = 'A'` and memory Y with `project_id = 'B'`, and their content is near-duplicate
- **WHEN** the consolidation runs
- **THEN** they SHALL NOT be considered candidates for the same merge, regardless of similarity

#### Scenario: A memory in the default project is not merged with one in another project

- **GIVEN** a near-duplicate pair, one memory in the default project and one in project `A`
- **WHEN** the consolidation runs
- **THEN** they SHALL NOT be considered candidates for the same merge
- **AND** the test asserting this SHALL be built on a fixture holding ops in TWO projects and SHALL assert a non-zero op count, so it cannot pass by having produced no ops at all

### Requirement: Every consolidation decision MUST be journaled

Every operation produced by the sweep — decay archive or deadline orphaning — SHALL be recorded in `consolidation_ops` with the operation type, affected ids, a deterministic reasoning string, the resulting created id (when applicable), and the application status. Historical op types (`merge`, `supersede`, `orphan_promote`) remain valid journal rows: they SHALL keep rendering in the dashboard and SHALL keep their undo semantics, but the sweep SHALL NOT produce new rows of those types.

#### Scenario: A decay archive is journaled

- **WHEN** the sweep archives memories A and B via decay
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'decay'`, `affected_ids = ['A','B']`, and a deterministic reasoning string

#### Scenario: A historical LLM-era op is still visible and undoable

- **GIVEN** a pre-upgrade `consolidation_ops` row with `op_type = 'merge'` whose referenced rows all exist
- **WHEN** the operator views the run and triggers undo for that op
- **THEN** the op SHALL render normally and the undo SHALL succeed exactly as before the upgrade

### Requirement: Every consolidation operation MUST be reversible

The dashboard and CLI SHALL provide an undo for any individual consolidation op and for an entire consolidation run, EXCEPT when one or more rows referenced by the op's `affected_ids` or `created_id` have been physically removed by `MemoryService.purgeDisconnectedArchived` or `AgentSessionsService.purgeEmpty`. In that case, undo SHALL fail with a structured error so the operator understands why.

Undoing an op SHALL restore the affected memories to `active` and SHALL transition any merged-into memory to `archived` so it is removed from active retrieval, when all referenced rows still exist.

Undo SHALL NOT create a second `active` memory in a `(scope, project_id, topic_key)` slot. Before reactivating an affected row (or, for an `orphan_promote` undo, the relation's target row) that carries a non-null `topic_key`, the undo SHALL check whether that slot already holds a _different_ active row (a newer memory saved with the same `topic_key` after the op was applied). When the slot is occupied, that row SHALL NOT be reactivated — it SHALL remain in its current `superseded`/`archived` state — while the remaining rows of the op are reactivated normally. Rows with a null `topic_key` are always reactivatable. The undo SHALL report which rows it skipped (id, `topic_key`, and the occupying active id), and the operator surface SHALL show that the undo was partial and why. The op SHALL still be marked reverted (it was undone to the extent convergence permits). This guarantee is additionally enforced at the storage layer by a UNIQUE partial index on the active-topic slot (see the `persistence` capability).

#### Scenario: Undoing a merge op when all rows still exist

- **GIVEN** a merge op resulted in memories A and B transitioning to `superseded` and a new memory M created with `status = 'active'`
- **AND** none of A, B, M have been purged
- **WHEN** the operator triggers undo for that op
- **THEN** A and B SHALL transition back to `active`, M SHALL transition to `archived`, and the op SHALL be marked as reverted in `consolidation_ops`

#### Scenario: Undoing a run when all rows still exist

- **WHEN** the operator triggers undo for an entire consolidation run and every affected_id of every op is still present in `memory` and `sessions`
- **THEN** every op in the run SHALL be reversed in reverse order, leaving the DB equivalent to its pre-run state aside from the journal entries themselves

#### Scenario: Undo is blocked when a referenced row has been purged

- **GIVEN** a merge op references memory ids `[A, B]` via `affected_ids` and `M` via `created_id`
- **AND** `M` has since been removed by `MemoryService.purgeDisconnectedArchived`
- **WHEN** the operator triggers undo for that op
- **THEN** the undo handler SHALL return `{ ok: false, code: 'purged_row_missing', missing: ['M'] }`
- **AND** the dashboard SHALL render that error inline on the consolidation runs view, naming the missing ids
- **AND** the op SHALL remain in its current state (NOT marked reverted, NOT mutated)
- **AND** rows A and B SHALL remain in their current state (NOT transitioned back to `active`)

#### Scenario: Undo is blocked when a purged session is referenced

- **GIVEN** a journal op references a session id that has since been removed by `AgentSessionsService.purgeEmpty`
- **WHEN** the operator triggers undo for that op
- **THEN** the undo handler SHALL return `{ ok: false, code: 'purged_row_missing', missing: [...sessionIds] }`
- **AND** the op SHALL NOT be reverted

#### Scenario: Undo does not resurrect a row into an occupied topic_key slot

- **GIVEN** memory R with `topic_key = K` was archived by a decay op
- **AND** a later `memory.save({topic_key: K})` in the same `(scope, project_id)` inserted a new active memory N in that slot (R was not active when N was saved, so no supersede linked them)
- **AND** neither R nor N has been purged
- **WHEN** the operator triggers undo for the decay op
- **THEN** N SHALL remain the sole `active` row in the `(scope, project_id, K)` slot
- **AND** R SHALL remain `archived` (NOT reactivated)
- **AND** the undo result SHALL name R among its skipped rows, identifying K and the occupying id N
- **AND** the op SHALL be marked reverted

#### Scenario: orphan_promote undo respects an occupied topic_key slot

- **GIVEN** an `orphan_promote` op recorded a `supersedes` verdict whose target T carries `topic_key = K`
- **AND** after that op, a `memory.save({topic_key: K})` inserted a new active memory N in T's slot
- **WHEN** the operator undoes the `orphan_promote` op
- **THEN** T SHALL NOT be reactivated (N remains the sole active row for K)
- **AND** the relation SHALL still be reset to `pending` and the source's `replaces[]` adjustment SHALL still be applied
- **AND** T SHALL be named among the undo's skipped rows

### Requirement: The consolidation MUST be idempotent on stable input

Running the sweep twice with no intervening writes SHALL produce zero new operations beyond noops. Specifically: the decay pass SHALL be a no-op if no row crossed the threshold since the previous run; the deadline-orphaning pass SHALL be a no-op if no pending relation crossed `JUDGMENT_ORPHAN_DEADLINE_MS` since the previous run.

#### Scenario: Back-to-back sweeps with no intervening saves

- **WHEN** the sweep runs twice in immediate succession (manual trigger bypassing the throttle)
- **THEN** the second run's `consolidation_runs.summary` SHALL show zero new decay archives and zero new orphanings

### Requirement: Purge ops are journaled but not themselves undoable

The consolidation journal SHALL include two new `op_type` values: `session_purge` (written by `AgentSessionsService.purgeEmpty`) and `archived_memory_purge` (written by `MemoryService.purgeDisconnectedArchived`). These ops record `affected_ids` (the deleted row ids) and `reasoning` (a static operator-purge string). The `created_id` column SHALL be NULL for both new op types.

Undo SHALL NOT be available for `session_purge` or `archived_memory_purge` ops. The rows they record are gone and cannot be reconstructed. Attempts to undo SHALL return `{ ok: false, code: 'not_undoable', reason: 'purge ops are terminal' }`.

#### Scenario: A purge op is journaled with the deleted ids

- **WHEN** `AgentSessionsService.purgeEmpty` deletes session ids `[s1, s2, s3]`
- **THEN** exactly one row SHALL be inserted into `consolidation_ops` with `op_type = 'session_purge'`, `affected_ids = ['s1','s2','s3']`, `created_id = NULL`, and `reasoning` matching the operator-purge static string

#### Scenario: An archived-memory purge op is journaled with the deleted ids

- **WHEN** `MemoryService.purgeDisconnectedArchived` deletes memory ids `[m1, m2]`
- **THEN** exactly one row SHALL be inserted into `consolidation_ops` with `op_type = 'archived_memory_purge'`, `affected_ids = ['m1','m2']`, `created_id = NULL`, and `reasoning` matching the operator-purge static string

#### Scenario: Undo on a purge op is rejected

- **GIVEN** a `consolidation_ops` row with `op_type IN ('session_purge', 'archived_memory_purge')`
- **WHEN** the operator triggers undo for that op
- **THEN** the undo handler SHALL return `{ ok: false, code: 'not_undoable', reason: 'purge ops are terminal' }`
- **AND** the dashboard SHALL render that response as a non-error informational message (purges are intentionally one-way)

### Requirement: Every consolidation op type MUST be classified as undoable or terminal, exhaustively

Undo currently enumerates terminal op types by literal comparison in two independent places — the service that performs the undo and the dashboard that decides whether to offer the button. An op type absent from both lists falls through to being marked reverted while its effect persists, which makes the journal report a revert that did not happen. `prompt_purge` is exactly that case today: the rows stay physically deleted and the operator is told the undo succeeded.

The classification SHALL come from a single exported set consumed by both the undo service and the dashboard guard. Every member of the op-type union SHALL fall into exactly one category — reactivating, terminal, orphan-promotion, or inert — and that exhaustiveness SHALL be asserted by an invariant test, so a newly-added op type cannot land in neither category.

#### Scenario: Undoing a prompt purge is refused

- **GIVEN** a journaled `prompt_purge` op
- **WHEN** an operator attempts to undo it
- **THEN** the attempt SHALL be refused as terminal and the op SHALL NOT be marked reverted

#### Scenario: The dashboard does not offer undo for a terminal op

- **GIVEN** a journaled `prompt_purge` op
- **WHEN** the operator views the run detail
- **THEN** the op SHALL be presented as terminal and no undo control SHALL be rendered

#### Scenario: A new op type must be classified

- **WHEN** a new consolidation op type is added to the union without being placed in a classification set
- **THEN** an invariant test SHALL fail and the build SHALL be rejected
