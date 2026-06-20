## MODIFIED Requirements

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

### Requirement: Removed configuration MUST degrade gracefully on upgrade

A server booting in an environment that still defines any removed variable (`LLM_PROVIDER`, `OPENAI_MODEL`, `CONSOLIDATION_ENABLED`, `CONSOLIDATION_CRON`, `CONSOLIDATION_BATCH_SIZE`) SHALL start normally and SHALL log a single warning naming the ignored variables. `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL` and `EMBEDDING_*` remain valid (embedding client). Boot SHALL NOT fail on a missing `OPENAI_API_KEY` under any combination. Upgrading a running installation SHALL require zero manual operator steps: no config rewrite and no plugin update. The boot-time migration runner MAY apply schema migrations automatically (including dropping the obsolete `consolidation_runs.llm_provider` / `llm_model` columns); such migrations SHALL run unattended, SHALL preserve all existing `consolidation_runs` / `consolidation_ops` rows, and SHALL NOT require any operator action.

#### Scenario: Boot with stale LLM env vars

- **WHEN** the server boots with `OPENAI_MODEL` and `CONSOLIDATION_CRON` still set
- **THEN** it SHALL reach the listening state and SHALL log one warning listing both names as ignored

#### Scenario: Upgrade boot applies the column-drop migration unattended

- **GIVEN** a database whose `consolidation_runs` table still has the `llm_provider` / `llm_model` columns and contains existing run and op rows
- **WHEN** the server boots after the upgrade
- **THEN** the migration runner SHALL rebuild `consolidation_runs` without those two columns, all pre-existing `consolidation_runs` and `consolidation_ops` rows (including historical `merge` / `supersede` ops) SHALL be preserved, and no operator action SHALL be required
