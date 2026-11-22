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

Every operation produced by the sweep — decay archive, deadline orphaning, or stale save-time pending drain — SHALL be recorded in `consolidation_ops` with the operation type, affected ids, a deterministic reasoning string, the resulting created id (when applicable), and the application status.

Deadline orphaning, rules drains and retired-endpoint drains SHALL all journal as `orphan_promote`, with the relation recorded as null and the judgment id as the created id. Each SHALL use its own reasoning prefix, so the three remain distinguishable.

Historical op types (`merge`, `supersede`) remain valid journal rows: they SHALL keep rendering in the dashboard and SHALL keep their undo semantics, but the sweep SHALL NOT produce new rows of those types. Historical `orphan_promote` rows that recorded a verdict SHALL keep rendering. Their undo SHALL follow "Undoing an orphaning MUST NOT overwrite a verdict written after it", which leaves unchanged every undo whose relation has not been written since the op.

An agent-driven merge confirmed through `memory.merge` (see the `mcp-api` capability, "The MCP server MUST expose `memory.merge` with a preview-then-confirm contract") SHALL be journaled as exactly one `merge` op, in its own `consolidation_runs` row with `scope = 'maintenance'` (the same journal path `memory.archive` uses; a `project:<projectId>` run would satisfy the sweep's per-scope throttle and silently skip that project's next sweep), with `affected_ids` = the merged originals in the caller's order, `created_id` = the successor, and a reasoning string naming the acting token. The op SHALL be written in the same transaction as the successor insert and the originals' status flip, so a merge that rolls back leaves no journal row. The sweep itself still SHALL NOT produce `merge` ops.

#### Scenario: A decay archive is journaled

- **WHEN** the sweep archives memories A and B via decay
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'decay'`, `affected_ids = ['A','B']`, and a deterministic reasoning string

#### Scenario: An agent merge is journaled as one merge op

- **WHEN** an agent confirms `memory.merge` over active memories A, B and C, creating successor M
- **THEN** exactly one new `consolidation_ops` row SHALL exist with `op_type = 'merge'`, `affected_ids = ['A','B','C']` and `created_id = 'M'`, in a new `consolidation_runs` row with `scope = 'maintenance'`
- **AND** the next session-start sweep for that project SHALL NOT be throttled by that run

#### Scenario: A historical LLM-era op is still visible and undoable

- **GIVEN** a pre-upgrade `consolidation_ops` row with `op_type = 'merge'` whose referenced rows all exist
- **WHEN** the operator views the run and triggers undo for that op
- **THEN** the op SHALL render normally and the undo SHALL succeed exactly as before the upgrade

#### Scenario: Deadline and drain orphanings are distinguishable in the journal

- **GIVEN** one run in which the deadline step orphaned relation R1, the drain orphaned relation R2 by the rules, and the drain orphaned relation R3 for a retired endpoint
- **WHEN** the run's ops are listed
- **THEN** all three SHALL be `orphan_promote` ops, and their reasoning prefixes SHALL differ: R1's names the deadline, R2's the rules drain and R3's the retired-endpoint drain

### Requirement: Every consolidation operation MUST be reversible

The dashboard and CLI SHALL provide an undo for any individual consolidation op and for an entire consolidation run, EXCEPT when one or more rows referenced by the op's `affected_ids` or `created_id` have been physically removed by `MemoryService.purgeDisconnectedArchived` or `AgentSessionsService.purgeEmpty`. In that case, undo SHALL fail with a structured error so the operator understands why.

Undoing an op SHALL restore the affected memories to `active` and SHALL transition any merged-into memory to `archived` so it is removed from active retrieval, when all referenced rows still exist. For a `merge` op the merged-into memory SHALL be archived BEFORE the originals are reactivated: the successor commonly holds the `topic_key` slot it inherited from one of its originals, and reactivating first would find that slot occupied by the successor itself and skip the original.

Undo SHALL NOT create a second `active` memory in a `(scope, project_id, topic_key)` slot. Before reactivating an affected row (or, for an `orphan_promote` undo, the relation's target row) that carries a non-null `topic_key`, the undo SHALL check whether that slot already holds a _different_ active row (a newer memory saved with the same `topic_key` after the op was applied). When the slot is occupied, that row SHALL NOT be reactivated — it SHALL remain in its current `superseded`/`archived` state — while the remaining rows of the op are reactivated normally. Rows with a null `topic_key` are always reactivatable. The undo SHALL report which rows it skipped (id, `topic_key`, and the occupying active id), and the operator surface SHALL show that the undo was partial and why. The op SHALL still be marked reverted (it was undone to the extent convergence permits). This guarantee is additionally enforced at the storage layer by a UNIQUE partial index on the active-topic slot (see the `persistence` capability).

#### Scenario: Undoing a merge op when all rows still exist

- **GIVEN** a merge op resulted in memories A and B transitioning to `superseded` and a new memory M created with `status = 'active'`
- **AND** none of A, B, M have been purged
- **WHEN** the operator triggers undo for that op
- **THEN** A and B SHALL transition back to `active`, M SHALL transition to `archived`, and the op SHALL be marked as reverted in `consolidation_ops`

#### Scenario: Undoing a merge whose successor inherited an original's topic_key

- **GIVEN** a merge op over A (`topic_key = K`) and B whose successor M took `topic_key = K`
- **WHEN** the operator triggers undo for that op
- **THEN** M SHALL be `archived`, A and B SHALL both be `active`, A SHALL be the sole active row for K, and the undo result SHALL report no skipped rows

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

Running the sweep twice with no intervening writes SHALL produce zero new operations beyond noops, except where a step's per-run bound left work for the next run. Specifically:

- the decay pass SHALL be a no-op if no row crossed the threshold since the previous run;
- the deadline-orphaning pass SHALL be a no-op if no pending relation crossed `JUDGMENT_ORPHAN_DEADLINE_MS` since the previous run;
- the stale save-time pending drain MAY re-examine relations it kept, but on stable input it SHALL reach the same verdict and SHALL produce no op for a relation any earlier run examined and kept.

#### Scenario: Back-to-back sweeps with no intervening saves

- **GIVEN** a scope whose decay candidates, overdue pending relations and drainable relations all fit within one run's bounds
- **WHEN** the sweep runs twice in immediate succession (manual trigger bypassing the throttle)
- **THEN** the second run's `consolidation_runs.summary` SHALL show zero new decay archives, zero new orphanings and zero drains

#### Scenario: A re-examined kept pair stays kept

- **GIVEN** a scope whose every examinable pending relation fits within one run's row cap, after one drain run
- **WHEN** the sweep runs again with no intervening writes
- **THEN** the drain SHALL orphan zero relations

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

The classification SHALL come from a single exported set consumed by both the undo service and the dashboard guard. Every member of the op-type union SHALL fall into exactly one category — reactivating, terminal, orphan-promotion, or inert — and that exhaustiveness SHALL be asserted by an invariant test, so a newly-added op type cannot land in neither category.

Undo currently enumerates terminal op types by literal comparison in two independent places — the service that performs the undo and the dashboard that decides whether to offer the button. An op type absent from both lists falls through to being marked reverted while its effect persists, which makes the journal report a revert that did not happen. `prompt_purge` is exactly that case today: the rows stay physically deleted and the operator is told the undo succeeded.

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

### Requirement: The drain MUST orphan pending pairs that fall in the low confidence band

The drain SHALL orphan a pending pair whose confidence band is `low`, because the save path no longer records a row for such a pair. It SHALL derive the band with `classifyCandidateBand`, the single shared classification function, and SHALL NOT restate the band thresholds. Its inputs are:

- the pair's cosine, read from stored vectors with the embedding model never loaded;
- whether the lexical channel admits the pair;
- whether the pair shares an entity, using the drain's conservative union of stored links and a fresh extraction.

A pair with an unknown cosine (a missing vector, or a vector index that is not current) SHALL be kept, as it is without bands. A pair with an unknown entity verdict SHALL be kept. A lexically admitted pair SHALL NEVER be drained as low. A pair no channel admits SHALL keep draining under the existing rules reason.

The journal reasoning of a low-band drain SHALL start with `low confidence band: ` and SHALL name the cosine and whether an entity was shared, so an operator can tell it from a rules drain.

#### Scenario: An entity-only pair with a low cosine is drained

- **GIVEN** a pending pair that shares an entity and has a known cosine of 0.65
- **WHEN** the drain examines it
- **THEN** the relation SHALL become `orphaned` and its journal reasoning SHALL start with `orphaned: low confidence band: `

#### Scenario: A vector-only pair just above the vector threshold is drained

- **GIVEN** a pending pair with a cosine of 0.72, no shared entity and no lexical admission
- **WHEN** the drain examines it
- **THEN** the relation SHALL be orphaned with the low confidence band reasoning

#### Scenario: A vector-only pair at the low-band ceiling or above is kept

- **GIVEN** a pending pair with a cosine of 0.76 and no shared entity
- **WHEN** the drain examines it
- **THEN** the relation SHALL stay `pending`

#### Scenario: An entity pair with an unknown cosine is kept

- **GIVEN** a pending pair that shares an entity and has no stored vector for one endpoint
- **WHEN** the drain examines it
- **THEN** the relation SHALL stay `pending`

#### Scenario: An entity pair that is also dense is kept

- **GIVEN** a pending pair that shares an entity and has a cosine of 0.72
- **WHEN** the drain examines it
- **THEN** the relation SHALL stay `pending`, because the pair is in the middle band

### Requirement: The sweep MUST drain a pending judgment only when no current save-time channel would admit its pair

The deterministic sweep SHALL include a permanent stale save-time pending drain step. It SHALL run after the deadline-orphaning step, in the same throttled per-scope run (see "The consolidation sweep MUST run lazily on session start, throttled per scope"), with no LLM, no cron and no new trigger. On every run it SHALL evaluate pending pairs against whatever save-time detection rules are current in that build.

For each pending `memory_relations` row it examines, the step SHALL re-evaluate the specific pair directly, with the relation's `source_id` as the saved memory and its `target_id` as the candidate, exactly as save-time detection orients them:

- **lexical:** the overlap measure the lexical channel reports for that pair (see the `memory` capability, "Save-time lexical candidate scoring MUST increase with match quality"), compared with `LEXICAL_CANDIDATE_FLOOR`;
- **vector:** the similarity the dense channel derives from the cosine distance between the two stored embeddings, compared with `VEC_THRESHOLD`;
- **entity:** whether the two memories share ANY entity, meaning the same kind and value. Each endpoint's entity set SHALL be its stored entity links unioned with a fresh extraction of its own title and content by the current extractor, for the source AND for the target. A scan record with no links does not prove that a memory has no entities: the backfill worker records one when extraction fails.

The lexical measure, the vector distance-to-similarity mapping and both threshold comparisons SHALL each be ONE implementation in core, called by save-time detection and by the drain alike, so the two cannot diverge. Extracting that implementation SHALL NOT change the behaviour of the shipped save path.

The pair SHALL be orphaned ONLY when its lexical measure is below `LEXICAL_CANDIDATE_FLOOR`, AND its vector similarity is below `VEC_THRESHOLD`, AND it shares no extracted entity. The entity check SHALL deliberately ignore the rarity gate save-time detection applies (see the `memory-entities` capability, "Entity overlap MUST be a save-time conflict-detection channel"). Link counts drift as a corpus grows, and draining a genuine identifier-anchored contradiction is the worst failure this step can have. The pairs it drains are therefore a subset of the pairs no current channel would admit.

The re-check SHALL NOT depend on rank. A pair SHALL NOT be drained because its target falls outside today's per-channel candidate pool or outside the per-save cap: pending rows were created from the top of a capped, pool-bounded list, and a corpus that has grown since can push a genuine pair out of the pool while it still clears the floor.

The step SHALL NOT select or orphan rows by age. Age-based orphaning remains the job of "Aged pending relations MUST be deterministically orphaned after a deadline".

Each drain SHALL be a single `pending` → `orphaned` transition with `marked_by_kind = 'consolidator'`, applied in ONE transaction together with its `orphan_promote` journal op. The relation's `judged_at` and the op's `applied_at` SHALL carry ONE timestamp, taken once per drain and passed to both writes. That op SHALL record the relation as null, the judgment id as the created id, and a deterministic reasoning string distinct from the deadline step's. A row that is no longer `pending` when its transition is attempted SHALL be skipped. The step SHALL write no memory row and SHALL NOT change a `judged` or `orphaned` relation.

#### Scenario: A pair no channel admits is drained and journaled

- **GIVEN** a pending relation whose source and target are both active and share only common words, with a lexical measure below `LEXICAL_CANDIDATE_FLOOR`, a vector similarity below `VEC_THRESHOLD`, and no shared extracted entity
- **WHEN** the sweep runs for their scope
- **THEN** the relation SHALL become `orphaned` with `marked_by_kind = 'consolidator'`
- **AND** one `orphan_promote` op SHALL record `affected_ids = [source, target]`, the judgment id as `created_id`, and the drain's reasoning string

#### Scenario: A lexically admitted pair is kept

- **GIVEN** a pending relation whose lexical measure is at or above `LEXICAL_CANDIDATE_FLOOR`, and whose vector similarity is below `VEC_THRESHOLD` with no shared entity
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending` and no op SHALL reference it

#### Scenario: A vector-admitted pair is kept

- **GIVEN** a pending relation whose lexical measure is below the floor and whose stored embeddings yield a vector similarity at or above `VEC_THRESHOLD`
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`

#### Scenario: A pair sharing any entity is kept, even one the rarity gate would block

- **GIVEN** a pending relation whose lexical measure is below the floor and whose vector similarity is below `VEC_THRESHOLD`, and whose endpoints share an extracted entity linked to more active memories than the rarity gate admits
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`

#### Scenario: A pair outside today's pool and cap is still kept

- **GIVEN** a pending relation whose lexical measure is at or above the floor, in a scope where more than `CANDIDATE_POOL_SIZE` other memories now rank above its target for the source's text
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`, even though a fresh save of the source would not reach that target within its pool or its per-save cap

#### Scenario: Age does not decide a drain

- **GIVEN** two pending relations created at the same instant and younger than `JUDGMENT_ORPHAN_DEADLINE_MS`, one admitted by a channel and one admitted by none
- **WHEN** the sweep runs
- **THEN** only the unadmitted relation SHALL be orphaned by the drain step
- **AND** the admitted relation SHALL remain `pending` until a verdict or the deadline step closes it

#### Scenario: The drain changes no memory and no closed relation

- **GIVEN** a scope holding judged relations, orphaned relations and active memories, and a recorded hash of those rows
- **WHEN** the drain step runs and orphans at least one pending relation
- **THEN** the memory rows and every relation that was not `pending` SHALL hash identically to before

#### Scenario: The journal op and the transition land together

- **GIVEN** a pending relation the drain selects, and a journal insert forced to fail
- **WHEN** the drain step processes it
- **THEN** the relation SHALL remain `pending` and no `orphan_promote` op SHALL reference it

#### Scenario: Extracting the shared predicate leaves the save path unchanged

- **GIVEN** the save-time calibration sweep and the existing save-time candidate tests
- **WHEN** they run before and after the per-pair predicate is extracted
- **THEN** the sweep output SHALL be byte-identical and every existing test SHALL pass unedited

### Requirement: The drain MUST keep a pair whose admission cannot be evaluated

Each channel's verdict for a pair SHALL be one of "admitted", "not admitted" and "unknown". The drain SHALL orphan a pair only when all three verdicts are "not admitted". Any "unknown" SHALL keep the pair `pending`. A verdict SHALL be "unknown" whenever the step cannot evaluate it against current data, including when:

- either endpoint has no stored embedding (vector channel);
- the vector index does not match the current embedding recipe (vector channel, see "The drain MUST NOT invoke the embedding model");
- extracting entities from either endpoint throws (entity channel);
- either endpoint's title plus content is longer than `DRAIN_MAX_PAIR_CHARS` (every channel);
- either memory row cannot be read;
- the re-check throws for the pair.

`DRAIN_MAX_PAIR_CHARS` bounds the cost of one pair's evaluation, because `memory.save` accepts content of any length. It SHALL be a named constant, not operator-configurable. Its value SHALL be carried by a committed worst-case measurement, and SHALL NOT exceed the entity extractor's input bound, so every pair the drain evaluates is extracted in full. The lengths SHALL be read before the content is loaded. The size bound and the three channels apply only to pairs whose endpoints are both readable and `active`. A retired-endpoint drain needs neither the content nor the channels (see "The drain MUST orphan pairs whose endpoint is retired").

A pair kept as unknown SHALL be evaluated again when the cursor next reaches it. A failure of the step itself SHALL NOT fail the run: the run SHALL still finish with its decay and deadline counts, and the failure SHALL be logged.

#### Scenario: A pair with a missing embedding is kept

- **GIVEN** a pending relation whose lexical measure is below the floor and that shares no entity, and whose target has no row in the vector index
- **WHEN** the drain evaluates it
- **THEN** the vector verdict SHALL be "unknown" and the relation SHALL remain `pending`

#### Scenario: A pair whose re-check throws is kept

- **GIVEN** a pending relation for which the pair evaluation throws
- **WHEN** the drain step processes it
- **THEN** the relation SHALL remain `pending`, no op SHALL reference it, and the remaining pairs of the run SHALL still be evaluated

#### Scenario: An extraction failure keeps the pair

- **GIVEN** a pending relation that the lexical and vector checks do not admit, and an entity extraction that throws for its target
- **WHEN** the drain evaluates it
- **THEN** the entity verdict SHALL be "unknown" and the relation SHALL remain `pending`

#### Scenario: A target scanned without links is still checked by fresh extraction

- **GIVEN** a pending relation that the lexical and vector checks do not admit, whose target has an entity-scan record but no entity links, and whose target text contains an identifier the extractor recognises and the source also contains
- **WHEN** the drain evaluates it
- **THEN** the entity verdict SHALL be "admitted" and the relation SHALL remain `pending`

#### Scenario: An oversized pair is kept

- **GIVEN** a pending relation whose source title plus content is longer than `DRAIN_MAX_PAIR_CHARS`
- **WHEN** the drain evaluates it
- **THEN** it SHALL NOT load or tokenize that content, the verdict SHALL be "unknown", and the relation SHALL remain `pending`

### Requirement: The drain MUST NOT invoke the embedding model

The drain SHALL read only the vectors already stored in `memory_vec`, the same way save-time detection's dense channel reads them: it looks up each memory's stored embedding and compares the two with `vec_distance_cosine`. It SHALL NOT load the embedding model, call it, or enqueue an embedding, and it SHALL NOT embed a memory whose vector is missing. A missing vector, including every vector in the window after a model-identity reset has wiped the index and before it has been re-embedded, SHALL make the vector verdict "unknown", so the pair stays `pending`.

A stored vector is trustworthy only while the vector index matches the current embedding recipe. The identity reset that wipes stale vectors runs only when the embedder loads, and it can be deferred, so a sweep can meet vectors written under an older recipe. The runner SHALL therefore receive an injected predicate, `vectorIndexCurrent: () => boolean`, evaluated at the start of each drain step. When it returns false, every pair's vector verdict in that step SHALL be "unknown". The predicate is injected rather than imported, because the drain may not import the embedding layer.

This SHALL hold by construction:

- the consolidation runner SHALL receive no embedder or embedding function among its dependencies. The boolean `vectorIndexCurrent` predicate is its only embedding-related input;
- no module the drain imports, directly or transitively, SHALL import the embedding layer.

#### Scenario: The drain runs with the embedding model not loaded

- **GIVEN** a process in which the embedding model has never been loaded, a pending relation whose endpoints both have stored vectors, and a pending relation whose target has none
- **WHEN** the sweep runs for their scope
- **THEN** the drain SHALL complete without loading or invoking the model
- **AND** it SHALL evaluate the first relation from the stored vectors and SHALL keep the second `pending`

#### Scenario: A wiped vector index keeps every pair

- **GIVEN** a scope whose vector index was wiped by a model-identity reset and has not been re-embedded, and pending relations that neither the lexical nor the entity check admits
- **WHEN** the sweep runs
- **THEN** every such relation SHALL remain `pending`, and the run summary SHALL count them as kept as unknown

#### Scenario: A vector index that predates the current recipe keeps the pair

- **GIVEN** `vectorIndexCurrent` returning false, and a pending relation whose stored vectors yield a similarity below `VEC_THRESHOLD` and that the lexical and entity checks do not admit
- **WHEN** the drain evaluates it
- **THEN** the vector verdict SHALL be "unknown" and the relation SHALL remain `pending`

#### Scenario: The runner's dependencies carry no embedder

- **WHEN** the consolidation runner's constructor options and the drain's import graph are inspected
- **THEN** the options SHALL match their declared key set exactly, with `vectorIndexCurrent` as the only embedding-related key
- **AND** neither SHALL include an embedder, an embedding function or a module of the embedding layer

### Requirement: The drain MUST orphan pairs whose endpoint is retired

The drain SHALL orphan a pending relation whose source or target has been superseded or archived: the row exists and its `status` is not `active`. Save-time detection admits only `active` targets and runs only for an `active` saved row, so the current rules would never create such a pair. The lifecycle change that retired the endpoint has overtaken the question the pair asked.

The agent queue already withholds such a row (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). No agent can therefore ever judge it, and before this change only the deadline step or an operator could close it.

Such a drain SHALL be written exactly like a rules drain: one transaction per pair, an `orphan_promote` journal op, and the same undo path. Its reasoning SHALL carry its own prefix, so an operator can tell a retired-endpoint drain from a rules drain.

The fail-safe still applies. When an endpoint row cannot be read, because it is missing or the read throws, the pair SHALL be kept. Only a readable, non-`active` endpoint triggers this drain.

#### Scenario: A superseded source is drained

- **GIVEN** a pending relation whose source was superseded by a `topic_key` revision
- **WHEN** the sweep runs
- **THEN** the drain SHALL orphan it with the retired-endpoint reasoning prefix
- **AND** an `orphan_promote` op SHALL journal it in the same transaction

#### Scenario: An archived target is drained

- **GIVEN** a pending relation whose target has been archived
- **WHEN** the sweep runs before `JUDGMENT_ORPHAN_DEADLINE_MS`
- **THEN** the drain SHALL orphan it with the retired-endpoint reasoning prefix

#### Scenario: An undone retired-endpoint drain is not drained again

- **GIVEN** a retired-endpoint drain that an operator has undone, so the relation is `pending` again
- **WHEN** later sweeps run
- **THEN** the drain SHALL NOT orphan that relation again

#### Scenario: An unreadable endpoint keeps the pair

- **GIVEN** a pending relation whose endpoint row cannot be read
- **WHEN** the sweep runs
- **THEN** the relation SHALL remain `pending`

### Requirement: The drain MUST re-evaluate a pair only within its own project

The drain SHALL select pending relations whose source and target both belong to the swept project. Every read the re-check performs SHALL concern only the pair's two memories within that project: their status, lengths, title and content, embeddings and entity links. No row of another project SHALL influence whether a pair is drained or kept. One project's backlog SHALL NOT prevent another project from making progress in the same sweep call.

#### Scenario: Another project's memories do not keep a pair

- **GIVEN** a pending relation in project A that no channel admits, and a memory in project B that restates its source word for word and shares its entities
- **WHEN** the sweep runs for project A
- **THEN** the relation SHALL be orphaned

#### Scenario: One project's backlog does not starve another

- **GIVEN** project A holding more drainable pending relations than the shared drain budget allows in one call, project B holding one drainable pending relation, and an injected clock that exhausts the budget while project A is being drained
- **WHEN** one forced `runAll` sweeps project A and then project B in the same call
- **THEN** project B's drain step SHALL still examine at least one pair, and project B's drainable relation SHALL be orphaned in that call

### Requirement: The drain MUST be bounded per run and advance a persisted cursor with wrap-around

Batching is a requirement, not an optimisation. The sweep runs on the server's single Node thread, and its database calls are synchronous, so a run blocks every other request for as long as it lasts. A backlog SHALL therefore be processed only in bounded runs, never in one unbounded pass.

Two bounds apply, and both SHALL be named constants, not operator-configurable, with values carried by a committed measurement:

- **`DRAIN_ROW_CAP`:** the most relations one scope's drain step examines in one run.
- **`DRAIN_BUDGET_MS`:** the wall-clock budget of drain time for ALL drain steps of one sweep call, shared across the scopes that call runs. One sweep call is one session-start callback, which sweeps the session's project and the default project, or one forced `runAll`, which sweeps every project. The budget SHALL count only the time spent inside the call's drain steps: it starts when the first drain step begins, not when the run begins, it SHALL NOT run during the decay and deadline steps of the call's later scopes, and it SHALL be checked between pairs.

A drain step SHALL stop at its row cap or when the shared budget is spent, whichever comes first, and the next run of that scope SHALL resume from the cursor. Every drain step SHALL examine at least one examinable pair, even when the shared budget is already spent, so a slow host and a late scope still make progress. The drain's time in one call is therefore bounded by `DRAIN_BUDGET_MS` plus, per scope of that call, one pair and the step's fixed reads, each pair bounded by `DRAIN_MAX_PAIR_CHARS`. The budget's value SHALL leave room for those per-scope costs at the measured project counts.

Each drain SHALL commit in its own transaction, holding only that pair's orphan and journal writes. No transaction SHALL span several pairs, a run or the backlog. A failure therefore rolls back only the pair it happened on.

An examinable relation is a `pending` relation whose source and target both belong to the scope, whatever their lifecycle, and that no reverted drain op references. The step SHALL examine them in `(created_at, judgment_id)` order, starting after the key of the last relation the previous run of the same scope examined. It SHALL exclude relations a reverted drain op references inside its selection, so excluded relations never occupy the row cap. It SHALL record that cursor in a nested object of the run's existing `consolidation_runs.summary` JSON (see "The drain's outcome MUST be visible to the operator"), with no new table or column. When a run reaches the end of the examinable relations, the cursor SHALL wrap: the step SHALL continue from the lowest key, within the same run while its bounds allow, and otherwise the next run SHALL start from there. A run SHALL NOT examine a relation twice. A missing or unparsable cursor SHALL start from the lowest key.

Kept pairs at the head of the order SHALL therefore never prevent later pairs from being examined. Because every run examines at least one pair, every examinable relation SHALL be examined within `P` runs of its scope, where `P` is the scope's examinable count. When no run is cut short by the shared budget, that SHALL happen within `ceil(P / DRAIN_ROW_CAP)` runs.

A relation whose drain op an operator has reverted SHALL NOT be drained again by any later run of the drain. This finality binds the drain only. The deadline step's selection does not read the journal, so an undone relation that later crosses `JUDGMENT_ORPHAN_DEADLINE_MS` SHALL be orphaned by the deadline step like any other pending relation.

#### Scenario: A backlog larger than one run is covered without starvation

- **GIVEN** a scope whose lowest `(created_at, judgment_id)` keys belong to more kept pending relations than one run's row cap, followed by drainable ones
- **WHEN** the sweep runs repeatedly (manually forced, bypassing the throttle)
- **THEN** each run SHALL examine at most the row cap, the cursor SHALL advance past the kept relations, and the drainable relations SHALL be orphaned by a later run

#### Scenario: A backlog larger than the cap is processed across runs

- **GIVEN** a scope holding 5 000 drainable pending relations, more than `DRAIN_ROW_CAP`
- **WHEN** one run executes
- **THEN** it SHALL examine at most `DRAIN_ROW_CAP` relations and stop, leaving the rest `pending`
- **AND** each later run SHALL resume after the recorded cursor until all 5 000 have been examined

#### Scenario: A failure mid-run keeps the drains already committed

- **GIVEN** a run in which the orphan-and-journal write of the third drainable pair fails
- **WHEN** the drain step processes the batch
- **THEN** the first two pairs SHALL remain `orphaned`, each with its `orphan_promote` op
- **AND** the third SHALL remain `pending` with no op, and the run SHALL continue with the fourth

#### Scenario: The cursor wraps to the start

- **GIVEN** a cursor that has passed the highest pending key of the scope, and a pending relation that became drainable after the cursor passed it
- **WHEN** the next runs execute
- **THEN** the step SHALL continue from the lowest key, and that relation SHALL be orphaned once reached

#### Scenario: The wall-clock budget ends a run early and the next run resumes

- **GIVEN** an injected clock that starts when the drain step begins and exhausts `DRAIN_BUDGET_MS` after two pairs
- **WHEN** the drain step runs
- **THEN** it SHALL examine two pairs, record the second one's key as the cursor, and the next run SHALL begin with the third

#### Scenario: A slow host still progresses

- **GIVEN** a sweep call whose earlier drain steps have already spent the shared budget when a scope's drain step begins
- **WHEN** that drain step runs
- **THEN** it SHALL examine exactly one pair and record that pair's key as the cursor

#### Scenario: Time spent before the drain does not consume its budget

- **GIVEN** a run whose decay and deadline steps take longer than `DRAIN_BUDGET_MS`, and an injected clock that keeps running through them
- **WHEN** the drain step runs
- **THEN** it SHALL examine pairs up to its row cap or its own budget, not just the minimum single pair

#### Scenario: An operator's undo is final for the drain

- **GIVEN** a drained relation whose `orphan_promote` op the operator has undone, restoring it to `pending`
- **WHEN** the cursor reaches that relation again on a later cycle
- **THEN** the drain SHALL NOT orphan it again

#### Scenario: The deadline step still closes an undone relation

- **GIVEN** a drained relation whose drain op the operator has undone, and that later becomes older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs
- **THEN** the deadline step SHALL orphan it with its own reasoning string, and the drain SHALL NOT be the step that orphans it

### Requirement: Undoing an orphaning MUST NOT overwrite a verdict written after it

Undoing an `orphan_promote` op SHALL reset the relation to `pending`, and SHALL apply any `supersedes` side-effect reversal, ONLY when the relation has not been written since the op: its `judged_at` is non-null and not later than the op's `applied_at`. The drain stamps both with one timestamp, so its own write always passes this test.

The guard is needed because `memory.compare` writes its verdict onto an existing relation for the same pair whatever that relation's status, so an orphaned relation can be judged after the op that orphaned it. A `supersedes` verdict also supersedes the target and adds it to the source's `replaces`, and today's undo reverses exactly that side effect.

When `judged_at` is null, the relation cannot be shown to be the op's own write. If it is `pending`, there is nothing to restore. In every null case, the relation SHALL be left as it is.

A relation the undo leaves as it is SHALL be reported (judgment id, current status and current relation), the operator surface SHALL show that the undo was partial and why, and the op SHALL still be marked reverted. This guard applies to every `orphan_promote` op, historical ones included.

#### Scenario: Undo restores a drained relation to pending

- **GIVEN** a relation orphaned by the drain step and not written since
- **WHEN** the operator undoes that `orphan_promote` op
- **THEN** the relation SHALL return to `status = 'pending'` with `relation`, `reason`, `judged_at`, `marked_by_kind` and `marked_by_actor` cleared, and the op SHALL be marked reverted

#### Scenario: Undo keeps a supersedes verdict written after the drain

- **GIVEN** a relation between two active memories, orphaned by the drain step and later judged `supersedes` through `memory.compare` on the same source and target, so the target is `superseded` and the source's `replaces` contains it
- **WHEN** the operator undoes that `orphan_promote` op
- **THEN** the relation SHALL remain `judged` with relation `supersedes`, the target SHALL remain `superseded`, and the source's `replaces` SHALL still contain the target
- **AND** the undo result SHALL name its judgment id as not restored, and the op SHALL be marked reverted

#### Scenario: Undo leaves a relation with no judged_at untouched

- **GIVEN** an `orphan_promote` op whose relation has a null `judged_at`
- **WHEN** the operator undoes that op
- **THEN** the relation SHALL be left as it is and reported as not restored, and the op SHALL be marked reverted

### Requirement: The drain's outcome MUST be visible to the operator

Each run's summary SHALL record the drain's outcome inside ONE nested object under the key `drain`, holding:

- the cursor;
- the counts examined, drained by the rules, drained for a retired endpoint, kept as admitted, and kept as unknown.

The summary's top-level keys SHALL stay `archives` and `orphaned`, with their current meaning. `memory.doctor` passes only the summary's top-level finite numbers through to `lastRunOps`, so its published output SHALL NOT change.

The dashboard's run-detail summary SHALL show the drained count beside the archived and orphaned counts (see the `dashboard` capability, "Consolidation runs MUST be inspectable and reversible from the dashboard"). Every drain op SHALL be listed and undoable from the existing consolidation views, individually and as part of its run. Its reasoning string SHALL identify it as a rules drain or a retired-endpoint drain, distinct from a deadline orphaning.

#### Scenario: A run that drained shows it

- **GIVEN** a run whose drain step orphaned two relations by the rules and one for a retired endpoint
- **WHEN** the operator opens that run's detail page
- **THEN** the summary SHALL show three drained, and the three `orphan_promote` ops SHALL be listed with their reasoning strings and an undo control

#### Scenario: memory.doctor output is unchanged by the drain

- **GIVEN** the latest run drained at least one relation
- **WHEN** an MCP client calls `memory.doctor`
- **THEN** `consolidation.lastRunOps` SHALL hold exactly the keys `archives` and `orphaned`

### Requirement: Retiring a memory MUST orphan its pending judgments in the same transaction

Every write that moves a memory from `active` to `superseded` or `archived` SHALL, in the SAME transaction, transition every `memory_relations` row with `status = 'pending'` whose `source_id` or `target_id` is that memory to `status = 'orphaned'`, with `marked_by_kind = 'consolidator'`. The pair's other endpoint SHALL NOT matter: a pair whose other endpoint is already `superseded` or `archived` SHALL be orphaned too, because a pair is adjudicable only while both of its endpoints are `active` (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired").

This SHALL hold on every retirement path, which today are:

- a `topic_key` revision in `memory.save`, for the superseded row;
- a `supersedes` verdict through `memory.judge` or `memory.compare`, for the target;
- a `memory.merge` commit, for every original;
- `memory.archive` and the dashboard's archive actions;
- the sweep's decay pass, for every memory it archives;
- an undo of a `merge` op, for the successor it archives.

Every path SHALL go through ONE shared core helper. The helper SHALL reuse the existing per-relation orphaning and `orphan_promote` journaling primitives that the sweep uses, and SHALL NOT implement a second orphan-and-journal path. A static test SHALL enumerate every repository method that moves a memory to `superseded` or `archived`, and every call site of those methods outside the repositories. It SHALL fail when a call site's enclosing function does not call the helper after the flip, and SHALL include a control proving that it reports a real retirement path whose helper call was removed.

Each orphaning SHALL be journaled as an `orphan_promote` op with `affected_ids = [source_id, target_id]`, the judgment id as `created_id`, the relation recorded as null, and a deterministic reasoning string. Its prefix, `endpoint retired at retirement`, SHALL differ from the deadline step's, the rules drain's and the retired-endpoint drain's, so an operator can tell the four apart. The relation's `judged_at` and the op's `applied_at` SHALL both carry the retirement's own timestamp.

Where the retirement journals its own op, which is `merge`, `agent_memory_archive` or `decay`, its orphanings SHALL be journaled in that op's run. Where it journals none, which is a `topic_key` revision, a `supersedes` verdict or a merge undo, they SHALL be journaled in ONE new run with scope `maintenance` and the summary `{"kind":"retirement_orphan","orphaned":N}`. That run SHALL be opened only when the retirement has at least one pending relation to orphan.

The retirement, its orphanings and their journal ops SHALL commit or roll back together. A failure in any of them SHALL fail the retirement and persist none of them. The helper SHALL write no memory row and SHALL change no relation that is not `pending`.

#### Scenario: A topic_key revision orphans the superseded memory's pending judgments

- **GIVEN** an active memory A holding `topic_key = 't'`, with a pending relation A→X and a pending relation Y→A
- **WHEN** `memory.save` is called with `topic_key = 't'`, superseding A
- **THEN** both relations SHALL be `orphaned` with `marked_by_kind = 'consolidator'` when the save returns
- **AND** one `maintenance` run with the summary `{"kind":"retirement_orphan","orphaned":2}` SHALL hold one `orphan_promote` op per relation, whose reasoning starts with `orphaned: endpoint retired at retirement:` and whose `applied_at` equals the relation's `judged_at`

#### Scenario: A supersedes verdict orphans the target's other pending judgments

- **GIVEN** active memories S, T and U, a pending relation S→T and a pending relation T→U
- **WHEN** an agent judges S→T `supersedes` through `memory.judge`
- **THEN** S→T SHALL be `judged` with relation `supersedes`, T SHALL be `superseded`, and T→U SHALL be `orphaned`
- **AND** a pending relation whose endpoints are S and another active memory SHALL remain `pending`

#### Scenario: A compare supersedes orphans the target's pending judgments

- **GIVEN** active memories S, T and U, no relation between S and T, and a pending relation U→T
- **WHEN** an agent calls `memory.compare` with `{ sourceId: S, targetId: T, relation: 'supersedes' }`
- **THEN** T SHALL be `superseded` and U→T SHALL be `orphaned`

#### Scenario: A merge orphans every original's pending judgments in the merge's run

- **GIVEN** active memories A and B, a pending relation A→X and a pending relation Y→B
- **WHEN** `memory.merge` commits A and B
- **THEN** both relations SHALL be `orphaned`, and their two `orphan_promote` ops SHALL belong to the same run as the `merge` op

#### Scenario: An archive orphans the memory's pending judgments in the archive's run

- **GIVEN** an active memory M with a pending relation M→X
- **WHEN** `memory.archive` archives M, or an operator archives it from the dashboard
- **THEN** M→X SHALL be `orphaned`, and its `orphan_promote` op SHALL belong to the same run as the `agent_memory_archive` op

#### Scenario: The decay pass orphans an archived memory's pending judgments in the sweep's run

- **GIVEN** a memory M that crosses the decay threshold, with a pending relation X→M
- **WHEN** the sweep runs for its scope
- **THEN** M SHALL be `archived`, X→M SHALL be `orphaned`, and its `orphan_promote` op SHALL belong to the same run as the `decay` op

#### Scenario: A merge undo orphans the successor's pending judgments

- **GIVEN** a committed merge whose successor N has a pending relation N→X created by its save-time detection
- **WHEN** the operator undoes the `merge` op, which archives N
- **THEN** N→X SHALL be `orphaned`, journaled in a new `maintenance` run of kind `retirement_orphan`, and the `merge` op's run SHALL gain no op

#### Scenario: A pair whose other endpoint is already retired is orphaned too

- **GIVEN** a pending relation A→B where B is already `superseded`, a row that predates this requirement
- **WHEN** A is archived
- **THEN** A→B SHALL be `orphaned` in the same transaction

#### Scenario: A retirement with nothing pending opens no run

- **GIVEN** an active memory A holding `topic_key = 't'` with no pending relation
- **WHEN** `memory.save` supersedes A through `topic_key = 't'`
- **THEN** no `consolidation_runs` row and no `consolidation_ops` row SHALL be written

#### Scenario: A failed journal insert rolls back the retirement and the orphaning

- **GIVEN** an active memory M with a pending relation M→X, on any retirement path, and an `orphan_promote` journal insert forced to fail
- **WHEN** the retirement is attempted
- **THEN** the call SHALL fail, M SHALL keep its previous `status`, M→X SHALL remain `pending`, and no `orphan_promote` op SHALL reference it

#### Scenario: Retirement orphanings are distinguishable from sweep orphanings

- **GIVEN** relations orphaned by the deadline step, by the rules drain, by the retired-endpoint drain and by a retirement
- **WHEN** their `orphan_promote` ops are listed
- **THEN** each SHALL carry a different reasoning prefix, and the retirement's SHALL be `endpoint retired at retirement`

#### Scenario: A retirement path that skips the helper fails the invariant test

- **GIVEN** a function that calls a repository method moving a memory to `superseded` or `archived` and does not call the helper after it
- **WHEN** the invariant test scans the source roots
- **THEN** it SHALL fail and name that function's file and line

### Requirement: Undoing a retirement MUST restore the pending judgments it orphaned

Undoing a `decay`, `agent_memory_archive` or `merge` op SHALL, in the same undo transaction and after reactivating its memories, also undo the orphanings that retirement made: the active `orphan_promote` ops of the same run whose reasoning carries the prefix `endpoint retired at retirement` and whose pair touches one of the memories the op retired. For each:

- when the relation was written after the op, its later verdict SHALL be kept and reported, and the op SHALL be marked reverted, exactly as "Undoing an orphaning MUST NOT overwrite a verdict written after it" requires;
- otherwise, when either endpoint is not `active` after the reactivation, the relation SHALL stay `orphaned`, its op SHALL stay active, and the undo SHALL report it with its judgment id and the retired endpoint. That happens when the memory stayed retired because a newer memory holds its `topic_key` slot, or when the other endpoint was retired since. Restoring it would re-create a pending row no agent can judge;
- otherwise, the relation SHALL return to `status = 'pending'` with its verdict fields cleared, and the op SHALL be marked reverted.

Undoing a whole run SHALL leave those linked ops to the retirement op's own undo, so their endpoints are checked after the reactivation. Undoing one linked op on its own SHALL keep restoring it to `pending`, whatever its endpoints, as for any other orphaning.

A retirement that has no undo, which is a `topic_key` revision, a `supersedes` verdict or a merge undo, SHALL NOT gain one through this requirement. Its orphanings SHALL remain individually undoable.

The operator surface SHALL show which relations an undo left orphaned and why, beside the existing partial-undo notes.

#### Scenario: Undoing an archive restores its pending judgments

- **GIVEN** a memory M archived through `memory.archive`, which orphaned the pending relation M→X
- **WHEN** the operator undoes the `agent_memory_archive` op
- **THEN** M SHALL be `active`, M→X SHALL be `pending` with `relation`, `reason`, `judged_at`, `marked_by_kind` and `marked_by_actor` cleared, and both ops SHALL be marked reverted

#### Scenario: Undoing a decay restores its pending judgments

- **GIVEN** a memory M archived by the decay pass, which orphaned the pending relation X→M
- **WHEN** the operator undoes the `decay` op
- **THEN** M SHALL be `active` and X→M SHALL be `pending`

#### Scenario: Undoing a merge restores the originals' pending judgments

- **GIVEN** a committed merge of A and B, which orphaned the pending relations A→X and Y→B
- **WHEN** the operator undoes the `merge` op
- **THEN** A and B SHALL be `active`, the successor SHALL be `archived`, and A→X and Y→B SHALL be `pending`

#### Scenario: Undoing a run restores the linked judgments once

- **GIVEN** a sweep run whose `decay` op archived M and orphaned X→M, and whose deadline step orphaned another relation R
- **WHEN** the operator undoes the whole run
- **THEN** M SHALL be `active`, X→M and R SHALL be `pending`, and every op of the run SHALL be marked reverted exactly once

#### Scenario: Undoing one retirement of a shared run restores only its own judgments

- **GIVEN** one run holding two `decay` ops, the first archiving M1, which orphaned M1→X, and the second archiving M2, which orphaned X→M2
- **WHEN** the operator undoes the first `decay` op
- **THEN** M1 SHALL be `active` and M1→X `pending`, while M2 SHALL stay `archived`, X→M2 SHALL stay `orphaned`, its op SHALL stay active, and the undo SHALL report no kept-orphaned judgment

#### Scenario: An undo keeps a verdict written after the orphaning

- **GIVEN** a memory M archived through `memory.archive`, which orphaned the relation M→X, and a later `memory.compare` that judged M→X `conflicts_with` in place
- **WHEN** the operator undoes the `agent_memory_archive` op
- **THEN** M SHALL be `active`, M→X SHALL remain `judged` with relation `conflicts_with`, the undo SHALL report its judgment id as a kept verdict, and its op SHALL be marked reverted

#### Scenario: An undo leaves a judgment orphaned while its other endpoint is retired

- **GIVEN** a memory M archived through `memory.archive`, which orphaned the relation M→X, and X superseded afterwards
- **WHEN** the operator undoes the `agent_memory_archive` op
- **THEN** M SHALL be `active`, M→X SHALL remain `orphaned`, its op SHALL remain active, and the undo SHALL report the judgment id with X as the retired endpoint

#### Scenario: A run undo leaves a judgment orphaned when its memory keeps a taken topic slot

- **GIVEN** a memory R holding `topic_key = 'k'`, archived by the decay pass, which orphaned the relation R→X, and a later memory N saved with `topic_key = 'k'`
- **WHEN** the operator undoes the whole sweep run
- **THEN** R SHALL remain `archived` and be reported as skipped, R→X SHALL remain `orphaned` and be reported, and its op SHALL remain active

#### Scenario: A topic_key revision's orphanings are undone one by one

- **GIVEN** a `topic_key` revision that superseded A and orphaned A→X into a `retirement_orphan` run
- **WHEN** the operator undoes that `orphan_promote` op
- **THEN** A→X SHALL return to `pending`, A SHALL remain `superseded`, and no memory SHALL change status

### Requirement: A late verdict on a judgment orphaned by a retirement MUST be accepted

A verdict sent through `memory.judge` or `memory.judge_batch` for a relation whose `status` is `orphaned` SHALL be accepted when the relation was orphaned by a retirement, and SHALL then be applied exactly as for a `pending` row. A relation was orphaned by a retirement when a non-reverted `orphan_promote` op has the relation's `judgmentId` as `created_id` and a reasoning that starts with `orphaned: endpoint retired at retirement: `.

Accepting SHALL move the relation from `orphaned` to `judged` with the verdict's `relation`, `reason`, `evidence`, `confidence`, kind and actor, in one conditional update that requires `status = 'orphaned'`. The new `judged_at` SHALL be later than the orphaning op's `applied_at`, so that the undo of that op keeps the verdict and reports it in `keptVerdicts` (see "Undoing an orphaning MUST NOT overwrite a verdict written after it").

The following SHALL still be refused with `conflict`, as before:

- a relation orphaned by the deadline step or by a drain (rules or retired-endpoint), and a relation whose retirement orphaning was undone;
- a `supersedes` verdict while either endpoint is not `active`, which leaves the relation `orphaned`.

#### Scenario: A late verdict on a retirement-orphaned judgment is accepted

- **GIVEN** a judgment S→T and a judgment T→U, both pending, and one `memory.judge_batch` that judges S→T `supersedes` and then T→U `related`
- **WHEN** the batch runs
- **THEN** S→T SHALL supersede T, which orphans T→U at that retirement, and T→U SHALL then be `judged` with relation `related`, with both verdicts reported as successes

#### Scenario: A late `not_conflict` dismissal is honoured at the next revision

- **GIVEN** an active memory B holding `topic_key = 'k'` with a pending pair B→X, a later save with `topic_key = 'k'` that retired B and orphaned B→X, and a late `not_conflict` verdict on B→X
- **WHEN** the next save with `topic_key = 'k'` computes its candidates
- **THEN** X SHALL NOT be offered as a candidate, through the `replaces` ancestry

#### Scenario: A deadline-orphaned or drain-orphaned judgment is still refused

- **GIVEN** a judgment orphaned by the deadline step, and another orphaned by the stale-endpoint drain
- **WHEN** an agent sends a verdict for each
- **THEN** both SHALL fail with `conflict: already 'orphaned'` and stay `orphaned`

#### Scenario: A `supersedes` verdict on a retired endpoint is still refused

- **GIVEN** a retirement-orphaned judgment T→U where T is `superseded`
- **WHEN** an agent sends `supersedes` for it
- **THEN** it SHALL fail with `conflict`, T→U SHALL stay `orphaned` and U SHALL stay `active`

#### Scenario: Undoing the retirement keeps the late verdict

- **GIVEN** a retirement-orphaned judgment that later received a verdict
- **WHEN** the operator undoes its `orphan_promote` op
- **THEN** the verdict SHALL be kept, the op SHALL be marked reverted, and the result SHALL list it in `keptVerdicts`

### Requirement: The consolidation sweep MUST skip archived projects

A sweep, whether a session-start `sweepFor` or a forced `runAll`, SHALL run only for projects with `archived_at IS NULL`. For an archived project the sweep SHALL perform no decay, no deadline orphaning and no stale-pending drain, and SHALL write no `consolidation_runs` row. The default project cannot be archived, so it is always swept and the empty-session purge anchored on its run is unaffected. An archived project SHALL be swept again from the first sweep after it is unarchived.

#### Scenario: A forced sweep leaves an archived project untouched

- **GIVEN** an active project `A` and an archived project `Z`, each with a memory past its decay threshold and a pending judgment older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the operator triggers a forced sweep
- **THEN** `A`'s memory SHALL be archived and `A`'s judgment SHALL be orphaned
- **AND** `Z`'s memory and `Z`'s judgment SHALL be unchanged
- **AND** no `consolidation_runs` row SHALL be written with scope `project:<Z>`

#### Scenario: Unarchiving brings a project back into the sweep

- **GIVEN** project `Z` was archived and has since been unarchived
- **WHEN** the next forced sweep runs
- **THEN** a `consolidation_runs` row SHALL be written for `project:<Z>`

### Requirement: Archive orphanings MUST be journaled with their own reason

Every judgment orphaned because its project was archived, at archive time or by the boot reconciliation, SHALL be journaled as an `orphan_promote` op with `created_id` set to the judgment id, both endpoints in `affected_ids`, and reasoning starting with `orphaned: project archived`. That prefix SHALL differ from the deadline's, the drain's and the retirement's, and a test SHALL pin all of them. The ops SHALL belong to a `consolidation_runs` row with scope `maintenance` whose summary is a JSON object with `kind = "project_archive_orphan"`, the `projectId`, `origin` (`"archive"` or `"reconcile"`) and the `orphaned` count. No run SHALL be written when nothing was orphaned.

#### Scenario: Archiving journals each orphaning

- **GIVEN** project `P` with three pending judgments
- **WHEN** the operator archives `P`
- **THEN** one `maintenance` run SHALL exist with `kind = "project_archive_orphan"`, `projectId = P`, `origin = "archive"` and `orphaned = 3`
- **AND** it SHALL hold three `orphan_promote` ops whose reasoning starts with `orphaned: project archived`

#### Scenario: Archiving a project with no pending judgments journals nothing

- **WHEN** the operator archives a project with no pending judgments
- **THEN** no `maintenance` run SHALL be written

### Requirement: Pending judgments of already-archived projects MUST be closed at process start

On every process start, the server SHALL orphan every `pending` judgment whose endpoints belong to an archived project, journaled as an archive orphaning with `origin = "reconcile"`. The reconciliation SHALL need no operator action. It SHALL be idempotent: with no such judgment it SHALL write nothing. It SHALL process the backlog in bounded batches, one transaction per batch, and SHALL yield the event loop between batches, so that a single start converges without blocking request handling for more than one batch. A failure SHALL be logged and SHALL NOT prevent the process from serving; the next start SHALL retry. It SHALL write no memory row.

#### Scenario: An upgrade closes an archived project's backlog

- **GIVEN** an archived project `Z` with pending judgments, written before this requirement existed
- **WHEN** the server process starts
- **THEN** every pending judgment of `Z` SHALL be `orphaned`
- **AND** each SHALL be journaled in a `maintenance` run with `kind = "project_archive_orphan"`, `projectId = Z` and `origin = "reconcile"`

#### Scenario: A converged installation does nothing at start

- **GIVEN** no archived project has a pending judgment
- **WHEN** the server process starts
- **THEN** no `consolidation_runs` row and no `consolidation_ops` row SHALL be written

#### Scenario: A backlog larger than one batch converges in one start

- **GIVEN** an archived project with more pending judgments than one reconciliation batch
- **WHEN** the server process starts
- **THEN** after the reconciliation finishes, the project SHALL have no pending judgment
- **AND** each batch SHALL have been committed in its own transaction

### Requirement: An orphaning MUST NOT be undone while its project is archived

Undoing any `orphan_promote` op whose judgment belongs to an archived project, whether it was written by an archive, the deadline, the drain or a retirement, singly or as part of an "Undo entire run", SHALL be refused with a `conflict` error and SHALL change no row. So SHALL undoing a memory retirement (`decay`, `agent_memory_archive`, `merge`, `supersede`) whose undo would restore such an orphaning as a side effect. The refusal SHALL name unarchiving the project as the restore path. A pending judgment in an archived project can be closed by no agent and no sweep, and the process-start reconciliation would close it again. Once the project is active, the op SHALL be undoable like any other orphaning.

#### Scenario: Undo is refused while archived

- **GIVEN** project `P` is archived and its archive run holds orphan ops
- **WHEN** the operator undoes one of those ops, or the whole run
- **THEN** the undo SHALL be refused with `conflict`
- **AND** every relation and op SHALL be unchanged

#### Scenario: A deadline orphaning in an archived project is not undoable either

- **GIVEN** a judgment orphaned by the deadline step while its project was active, and the project archived since
- **WHEN** the operator undoes that deadline op
- **THEN** the undo SHALL be refused with `conflict` and no row SHALL change

#### Scenario: Undoing a memory retirement cannot re-open an archived project's judgment

- **GIVEN** a memory of project `P` archived from the dashboard, whose pending judgment that retirement orphaned, and `P` archived since
- **WHEN** the operator undoes that memory archive, singly or as its whole run
- **THEN** the undo SHALL be refused with `conflict` and no row SHALL change

#### Scenario: Undo works after unarchive for an op unarchive could not restore

- **GIVEN** project `P` was unarchived and one of its archive orphanings stayed orphaned because an endpoint was no longer `active`
- **WHEN** the operator undoes that op
- **THEN** the undo SHALL proceed under the existing `orphan_promote` undo rules

### Requirement: A restored judgment's deadline MUST count from its restore

The deadline orphaning step SHALL NOT select a `pending` judgment whose archive orphaning was reverted less than `JUDGMENT_ORPHAN_DEADLINE_MS` ago, even when its `created_at` is older than the deadline. Once that window has passed, the deadline step SHALL apply to it as to any pending judgment.

#### Scenario: A project archived for a month is unarchived

- **GIVEN** a judgment created 40 days ago, orphaned when its project was archived 30 days ago, and restored by unarchiving today
- **WHEN** a sweep of its project runs today
- **THEN** the judgment SHALL remain `pending`

#### Scenario: The restored window expires

- **GIVEN** the same judgment, still pending 15 days after its restore
- **WHEN** a sweep of its project runs
- **THEN** the judgment SHALL be orphaned by the deadline step
