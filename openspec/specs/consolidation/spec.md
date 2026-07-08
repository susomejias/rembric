# consolidation Specification

## Purpose

Defines the deterministic consolidation sweep that resolves memory pollution (decay and aged-pending orphaning) while preserving append-only semantics, scope isolation, journaling, and reversibility.

## Requirements

### Requirement: The consolidation sweep MUST run lazily on session start, throttled per scope

The server SHALL run the deterministic consolidation sweep (decay + deadline orphaning) as a side effect of session creation — both `POST /api/sessions` / `POST /api/<slug>/sessions` and MCP `memory.session_start` SHALL funnel through the same service method. The sweep SHALL be throttled: it SHALL short-circuit when the most recent `consolidation_runs` row for the target scope is younger than the internal minimum interval (24h). Sweep execution SHALL happen off the request's critical path: a sweep failure SHALL be logged and SHALL NOT fail the session call. A manually triggered run via `POST /admin/consolidation/run` (or the dashboard equivalent) SHALL remain possible at any time and SHALL bypass the throttle.

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

### Requirement: Aged pending relations MUST be deterministically orphaned after a deadline

A `memory_relations` row with `status = 'pending'` and `created_at < (now - JUDGMENT_ORPHAN_DEADLINE_MS)` (default 14 days) SHALL be transitioned to `status = 'orphaned'` by the sweep, with `marked_by_kind = 'consolidator'`. Each orphaning SHALL be journaled in `consolidation_ops` and SHALL be undoable while the referenced rows exist. No LLM SHALL be involved. Between `JUDGMENT_ORPHAN_AFTER_MS` (default 24h) and the deadline, the pending row SHALL be surfaced to agents via `memory.context` (see `mcp-api` capability) so it can be closed with `memory.judge` under fresh context.

The orphaning pass SHALL select its candidates with a query scoped to the swept scope (the scope filter applied in SQL, oldest-first, bounded by the per-run batch size). Rows belonging to other scopes SHALL NOT consume the swept scope's batch budget, so a backlog in one scope cannot starve another scope's overdue pendings.

#### Scenario: A pending relation crosses the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs for its scope
- **THEN** the row SHALL transition to `status = 'orphaned'` and a journaled op SHALL record it; the orphaned status is final unless a future `memory.judge` or `memory.compare` call writes a fresh row

#### Scenario: A pending relation is between the re-expose threshold and the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_AFTER_MS` but younger than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs
- **THEN** the row SHALL remain `pending` (only `memory.context` exposure applies)

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

The consolidation SHALL operate one (scope, project_id) tuple at a time. A single consolidation op SHALL NOT touch memories that span more than one scope or more than one project.

#### Scenario: Two memories of different projects look similar

- **GIVEN** memory X has `scope = 'project'`, `project_id = 'A'` and memory Y has `scope = 'project'`, `project_id = 'B'`, and their content is near-duplicate
- **WHEN** the consolidation runs
- **THEN** they SHALL NOT be considered candidates for the same merge, regardless of similarity

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
