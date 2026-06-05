# consolidation — delta for remove-llm-consolidation

## ADDED Requirements

### Requirement: The consolidation sweep MUST run lazily on session start, throttled per scope

The server SHALL run the deterministic consolidation sweep (decay + deadline orphaning) as a side effect of session creation — both `POST /api/sessions` / `POST /api/<slug>/sessions` and MCP `memory.session_start` SHALL funnel through the same service method. The sweep SHALL be throttled: it SHALL short-circuit when the most recent `consolidation_runs` row for the target scope is younger than the internal minimum interval (6h). Sweep execution SHALL happen off the request's critical path: a sweep failure SHALL be logged and SHALL NOT fail the session call. A manually triggered run via `POST /admin/consolidation/run` (or the dashboard equivalent) SHALL remain possible at any time and SHALL bypass the throttle.

#### Scenario: First session start after the throttle window triggers a sweep

- **GIVEN** the newest `consolidation_runs` row for the scope is older than the minimum interval (or absent)
- **WHEN** a session is started in that scope
- **THEN** the sweep SHALL run for that scope and a new `consolidation_runs` row SHALL be created with `started_at` set and `llm_provider`/`llm_model` NULL

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

#### Scenario: A pending relation crosses the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs for its scope
- **THEN** the row SHALL transition to `status = 'orphaned'` and a journaled op SHALL record it; the orphaned status is final unless a future `memory.judge` or `memory.compare` call writes a fresh row

#### Scenario: A pending relation is between the re-expose threshold and the deadline

- **GIVEN** a pending relation older than `JUDGMENT_ORPHAN_AFTER_MS` but younger than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the sweep runs
- **THEN** the row SHALL remain `pending` (only `memory.context` exposure applies)

### Requirement: Removed configuration MUST degrade gracefully on upgrade

A server booting in an environment that still defines any removed variable (`LLM_PROVIDER`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `CONSOLIDATION_ENABLED`, `CONSOLIDATION_CRON`, `CONSOLIDATION_BATCH_SIZE`) SHALL start normally and SHALL log a single warning naming the ignored variables. Upgrading a running installation SHALL require zero manual steps: no DB migration, no config rewrite, no plugin update.

#### Scenario: Boot with stale LLM env vars

- **WHEN** the server boots with `OPENAI_API_KEY` and `CONSOLIDATION_CRON` still set
- **THEN** it SHALL reach the listening state and SHALL log one warning listing both names as ignored

## MODIFIED Requirements

### Requirement: The consolidation MUST target redundancy, drift, contradiction, and decay

The consolidation sweep SHALL perform exactly two passes per run: (1) decay (deterministic, no LLM), and (2) deadline orphaning of pending relations older than `JUDGMENT_ORPHAN_DEADLINE_MS`. The LLM-driven detection of redundancy / drift / contradiction over the full corpus is REMOVED — that work moves to save-time as `memory.save` candidate detection. The LLM judging of aged pending relations is REMOVED — aged pendings are re-exposed to agents via `memory.context` and deterministically orphaned at the deadline.

#### Scenario: A memory has not been seen for a long time

- **GIVEN** a memory whose `last_seen_at` is older than the decay threshold and whose `confidence` count is below the floor
- **WHEN** the sweep runs
- **THEN** the memory SHALL transition from `active` to `archived` without an LLM call (decay path is unchanged)

#### Scenario: Two near-duplicate memories save apart from each other

- **GIVEN** the second save's candidate detection found the first as a candidate
- **WHEN** that save returned `candidates: [{...}]` and the agent never called `memory.judge`
- **THEN** after `JUDGMENT_ORPHAN_AFTER_MS` the pending relation SHALL appear in `memory.context.pendingJudgments[]`, and after `JUDGMENT_ORPHAN_DEADLINE_MS` without judgment the sweep SHALL orphan it — no LLM is invoked at any point

### Requirement: Every consolidation decision MUST be journaled

Every operation produced by the sweep — decay archive or deadline orphaning — SHALL be recorded in `consolidation_ops` with the operation type, affected ids, a deterministic reasoning string, the resulting created id (when applicable), and the application status. Historical op types (`merge`, `supersede`, `orphan_promote`) remain valid journal rows: they SHALL keep rendering in the dashboard and SHALL keep their undo semantics, but the sweep SHALL NOT produce new rows of those types.

#### Scenario: A decay archive is journaled

- **WHEN** the sweep archives memories A and B via decay
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'decay'`, `affected_ids = ['A','B']`, and a deterministic reasoning string

#### Scenario: A historical LLM-era op is still visible and undoable

- **GIVEN** a pre-upgrade `consolidation_ops` row with `op_type = 'merge'` whose referenced rows all exist
- **WHEN** the operator views the run and triggers undo for that op
- **THEN** the op SHALL render normally and the undo SHALL succeed exactly as before the upgrade

### Requirement: The consolidation MUST be idempotent on stable input

Running the sweep twice with no intervening writes SHALL produce zero new operations beyond noops. Specifically: the decay pass SHALL be a no-op if no row crossed the threshold since the previous run; the deadline-orphaning pass SHALL be a no-op if no pending relation crossed `JUDGMENT_ORPHAN_DEADLINE_MS` since the previous run.

#### Scenario: Back-to-back sweeps with no intervening saves

- **WHEN** the sweep runs twice in immediate succession (manual trigger bypassing the throttle)
- **THEN** the second run's `consolidation_runs.summary` SHALL show zero new decay archives and zero new orphanings

## REMOVED Requirements

### Requirement: The consolidation MUST run automatically on a schedule

**Reason**: The cron scheduler is removed; hygiene only matters at read time, and read time implies session traffic, which now triggers the throttled lazy sweep.
**Migration**: No operator action. `CONSOLIDATION_CRON`/`CONSOLIDATION_ENABLED` are ignored with a boot warning; the first session start after upgrade runs the sweep, which subsumes anything the cron would have done. The manual dashboard trigger is unchanged.

### Requirement: LLM judge output MUST be validated

**Reason**: There is no LLM judge anymore; the sweep is fully deterministic.
**Migration**: Pending relations are closed by agents via `memory.judge` (re-exposed through `memory.context`) or deterministically orphaned at the deadline. Historical `orphan_promote` journal rows remain valid and undoable.
