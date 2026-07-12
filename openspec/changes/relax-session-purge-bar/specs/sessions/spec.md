## MODIFIED Requirements

### Requirement: `sessionHasContent` is the single source-of-truth predicate for "this session is worth surfacing"

`AgentSessionsService` SHALL define an internal SQL predicate, `sessionHasContent(s, { requireCuratedSummary: boolean })`, returning TRUE for a `sessions` row `s` iff at least ONE of the following holds:

1. `requireCuratedSummary` is `true` AND `s.summary IS NOT NULL AND s.summary_final = 1`; OR `requireCuratedSummary` is `false` AND `s.summary IS NOT NULL` (curation not required), OR
2. `s.title_final = 1`, OR
3. there exists at least one row in `memory` with `session_id = s.id`, OR
4. there exists at least one row in `prompts` with `session_id = s.id` AND `deleted_at IS NULL`, OR
5. there exists at least one row in `confirmations` with `session_id = s.id`.

`recentForContext` SHALL evaluate the predicate with `requireCuratedSummary: true` — a session whose only "content" is a raw, uncurated transcript dump (`summary IS NOT NULL` but `summary_final = 0`) SHALL NOT satisfy clause 1 for this purpose, and therefore SHALL NOT surface in `memory.context.recentSessions` unless clauses 2–5 apply. This is unchanged from the prior version of this requirement.

`countPurgeableEmpty` and `purgeEmpty` (see "Sessions MAY be physically purged when empty") SHALL evaluate the predicate with `requireCuratedSummary: false` — a session with ANY summary text, curated or not, satisfies clause 1 for purge-eligibility purposes and is therefore NOT purge-eligible on that basis alone. This is the behavioral change this requirement introduces: a session is no longer treated as "empty" for deletion purposes merely because its summary was never curated.

Soft-deleted prompts (`deleted_at IS NOT NULL`) DO NOT make a session content-bearing; the operator has already marked them as obsolete, and a session that has nothing else SHALL be eligible for purge (under the `requireCuratedSummary: false` evaluation) and SHALL NOT surface in `memory.context.recentSessions` (under the `requireCuratedSummary: true` evaluation).

The predicate SHALL be implemented as a single private SQL-fragment helper. It SHALL be the ONLY place in the codebase where this five-clause predicate is expressed, for either evaluation mode — the two modes SHALL differ only in clause 1's curation requirement, never in clauses 2–5, and SHALL NOT be expressed as two independently-maintained SQL fragments. The `countPurgeableEmpty` and `purgeEmpty` methods SHALL consume the predicate in negated form (`NOT sessionHasContent(s, {requireCuratedSummary: false})`) as part of their "purgeable" check. `recentForContext` SHALL consume the predicate in positive form with `requireCuratedSummary: true` as part of its "is useful to surface" check.

When a future content-bearing table is added with a `session_id` foreign key (the canonical example being a hypothetical `tool_calls` table), the predicate SHALL be the single point of update — the new EXISTS clause is added once, to clauses 2–5, and every call site (both evaluation modes) picks it up automatically.

#### Scenario: A session with a curated summary satisfies the predicate under both evaluation modes

- **GIVEN** session `S` with `summary = 'Goal: ...'`, `summary_final = 1`, and no anchored memory/prompt/confirmation rows
- **WHEN** any call site evaluates `sessionHasContent(S, {requireCuratedSummary: true})` or `sessionHasContent(S, {requireCuratedSummary: false})`
- **THEN** the predicate SHALL return TRUE in both cases

#### Scenario: A session with only a raw, uncurated summary fails the context-surfacing evaluation but satisfies the purge evaluation

- **GIVEN** session `S` with `summary = '<raw transcript dump>'`, `summary_final = 0`, `title_final = 0`, and no anchored memory/prompt/confirmation rows
- **WHEN** `recentForContext` evaluates `sessionHasContent(S, {requireCuratedSummary: true})`
- **THEN** the predicate SHALL return FALSE, and `S` SHALL NOT appear in `memory.context.recentSessions`
- **WHEN** `countPurgeableEmpty`/`purgeEmpty` evaluate `sessionHasContent(S, {requireCuratedSummary: false})`
- **THEN** the predicate SHALL return TRUE (via clause 1's relaxed form), and `S` SHALL NOT become eligible for `purgeEmpty` regardless of age

#### Scenario: A session with anchored memory but no curated summary still satisfies the predicate

- **GIVEN** session `S` with `summary_final = 0` (or `summary IS NULL`) and at least one `memory` row with `session_id = S.id`
- **WHEN** any call site evaluates `sessionHasContent(S, ...)` (either mode)
- **THEN** the predicate SHALL return TRUE via clause 3 — anchored content keeps a session surfacing and non-purgeable regardless of the evaluation mode

#### Scenario: A session with no content at all fails the predicate under both evaluation modes

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** any call site evaluates `sessionHasContent(S, ...)` (either mode)
- **THEN** the predicate SHALL return FALSE in both cases, and `S` remains eligible for `purgeEmpty` once its age crosses the existing purge floor

#### Scenario: Drift between purge predicate and context predicate is impossible

- **GIVEN** the codebase as a whole
- **WHEN** any reviewer reads `countPurgeableEmpty`, `purgeEmpty`, and `recentForContext`
- **THEN** each SHALL reference `sessionHasContent` rather than inlining its five clauses, passing only the `requireCuratedSummary` option to select the evaluation mode
- **AND** a code search for `EXISTS (SELECT 1 FROM memory WHERE session_id` outside the helper definition SHALL return zero matches

### Requirement: Sessions MAY be physically purged when empty

A session row SHALL be physically deletable from the `sessions` table ONLY through `AgentSessionsService.purgeEmpty({ adminBypass: true })` and ONLY when the row satisfies all of the following at the moment of deletion:

1. `status IN ('ended', 'abandoned')`.
2. `deleted_at IS NULL` (the row has not been operator-soft-deleted; soft-deleted rows are preserved as operator intent).
3. `NOT sessionHasContent(s, { requireCuratedSummary: false })` — no summary text at all (curated or raw) was ever written, AND `title_final = false` (no human-meaningful label was ever written), AND no row is anchored via `memory`, non-deleted `prompts`, or `confirmations` (see "`sessionHasContent` is the single source-of-truth predicate..."). A session with a raw, uncurated summary no longer satisfies "empty" for this purpose — only the complete absence of any summary text does.
4. `ended_at IS NOT NULL AND ended_at < (now − 3_600_000)` (a 1-hour grace period after end to avoid racing with late-arriving summary writes).

The method SHALL run the predicate and the `DELETE` inside a single SQLite transaction. The method SHALL write a `consolidation_ops` row with `op_type = 'session_purge'`, `affected_ids` carrying the deleted ids, and a static `reasoning` string, in the same transaction.

Without `adminBypass: true`, the method SHALL throw `DomainError('forbidden', ...)` and SHALL NOT touch the database.

#### Scenario: An empty ended session older than the grace period is purged

- **GIVEN** session `S` with `status='ended'`, `deleted_at=NULL`, `summary=NULL`, `title_final=false`, `ended_at = now − 2h`, and zero referencing rows in `memory`, non-deleted `prompts`, `confirmations`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL be removed from `sessions`
- **AND** a row SHALL exist in `consolidation_ops` with `op_type='session_purge'` and `affected_ids` containing `S.id`
- **AND** the response SHALL include `S.id` in `deletedIds`

#### Scenario: A session with a genuine but uncurated summary is no longer purged

- **GIVEN** session `S` with `status='ended'`, `deleted_at=NULL`, `summary='<substantive raw transcript>'`, `summary_final=false`, `title_final=false`, `ended_at = now − 2h`, and zero referencing rows in `memory`, non-deleted `prompts`, `confirmations`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions` (clause 3 is no longer satisfied — the session has summary text, even though it was never curated)
- **AND** `S.id` SHALL NOT appear in the response's `deletedIds`

#### Scenario: A session within the grace period is preserved

- **GIVEN** session `S` matching the purge predicate except `ended_at = now − 10 minutes`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions`
- **AND** `S.id` SHALL NOT appear in the response's `deletedIds`

#### Scenario: A soft-deleted empty session is preserved

- **GIVEN** session `S` matching the purge predicate except `deleted_at` is set to a past timestamp
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions` — operator soft-delete is interpreted as "do not touch this row"

#### Scenario: A non-admin caller is rejected before any read

- **WHEN** `AgentSessionsService.purgeEmpty({})` or `AgentSessionsService.purgeEmpty({ adminBypass: false })` is called
- **THEN** the method SHALL throw `DomainError('forbidden', ...)`
- **AND** SHALL NOT issue any SQL statement

#### Scenario: A session with even a single referencing memory is preserved

- **GIVEN** session `S` matching the purge predicate except one row in `memory` has `session_id = S.id`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions`
- **AND** the memory row SHALL be unaffected

#### Scenario: A session with only soft-deleted prompts is now purgeable

- **GIVEN** session `S` matching the purge predicate except its `prompts` references are all soft-deleted (`deleted_at IS NOT NULL`)
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL be removed from `sessions` (the predicate now ignores soft-deleted prompts)
- **AND** `S.id` SHALL appear in the response's `deletedIds`
- **AND** the soft-deleted prompts SHALL remain in the `prompts` table (their physical purge is governed by the separate "Purge deleted prompts" flow under `/dashboard/maintenance`)

#### Scenario: A session with even one non-deleted prompt is preserved

- **GIVEN** session `S` matching the purge predicate except one row in `prompts` has `session_id = S.id AND deleted_at IS NULL`
- **WHEN** `AgentSessionsService.purgeEmpty({ adminBypass: true })` is called
- **THEN** the row SHALL remain in `sessions`
- **AND** the prompt row SHALL be unaffected
