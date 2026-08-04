## MODIFIED Requirements

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
