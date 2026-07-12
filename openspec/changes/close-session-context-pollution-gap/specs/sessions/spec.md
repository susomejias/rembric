## MODIFIED Requirements

### Requirement: `sessionHasContent` is the single source-of-truth predicate for "this session is worth surfacing"

`AgentSessionsService` SHALL define an internal SQL predicate, `sessionHasContent(s)`, returning TRUE for a `sessions` row `s` iff at least ONE of the following holds:

1. `s.summary IS NOT NULL AND s.summary_final = 1`, OR
2. `s.title_final = 1`, OR
3. there exists at least one row in `memory` with `session_id = s.id`, OR
4. there exists at least one row in `prompts` with `session_id = s.id` AND `deleted_at IS NULL`, OR
5. there exists at least one row in `confirmations` with `session_id = s.id`.

Clause 1 requires the summary to be curated (`summary_final = 1`), matching the curation requirement clause 2 already imposes on the title. A session whose only "content" is a raw, uncurated transcript dump (`summary IS NOT NULL` but `summary_final = 0`) — e.g. the fallback `session-end.sh` writes when the agent never called `memory.session_summary` — SHALL NOT satisfy clause 1. It still satisfies the predicate via clauses 3–5 if real memories/prompts/confirmations are anchored to it, even without a curated summary.

Soft-deleted prompts (`deleted_at IS NOT NULL`) DO NOT make a session content-bearing; the operator has already marked them as obsolete, and a session that has nothing else SHALL be eligible for purge and SHALL NOT surface in `memory.context.recentSessions`.

The predicate SHALL be implemented as a single private SQL-fragment helper inside `apps/server/src/services/agent-sessions.ts`. It SHALL be the ONLY place in the codebase where this five-clause predicate is expressed. The `countPurgeableEmpty` and `purgeEmpty` methods SHALL consume the predicate in negated form (`NOT sessionHasContent(s)`) as part of their "purgeable" check. `recentForContext` SHALL consume the predicate in positive form as part of its "is useful to surface" check.

When a future content-bearing table is added with a `session_id` foreign key (the canonical example being a hypothetical `tool_calls` table), the predicate SHALL be the single point of update — the new EXISTS clause is added once, and every call site picks it up automatically.

#### Scenario: A session with a curated summary satisfies the predicate

- **GIVEN** session `S` with `summary = 'Goal: ...'`, `summary_final = 1`, and no anchored memory/prompt/confirmation rows
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with only a raw, uncurated summary fails the predicate

- **GIVEN** session `S` with `summary = '<raw transcript dump>'`, `summary_final = 0`, `title_final = 0`, and no anchored memory/prompt/confirmation rows
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return FALSE
- **AND** `S` SHALL become eligible for `purgeEmpty` once its age crosses the existing purge floor
- **AND** `S` SHALL NOT appear in `memory.context.recentSessions`

#### Scenario: A session with anchored memory but no curated summary still satisfies the predicate

- **GIVEN** session `S` with `summary_final = 0` (or `summary IS NULL`) and at least one `memory` row with `session_id = S.id`
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return TRUE via clause 3 — anchored content keeps a session surfacing even when the agent never curated a summary for it

#### Scenario: A session with no content fails the predicate

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return FALSE

#### Scenario: Drift between purge predicate and context predicate is impossible

- **GIVEN** the codebase as a whole
- **WHEN** any reviewer reads `countPurgeableEmpty`, `purgeEmpty`, and `recentForContext`
- **THEN** each SHALL reference `sessionHasContent` rather than inlining its five clauses
- **AND** a code search for `EXISTS (SELECT 1 FROM memory WHERE session_id` outside the helper definition SHALL return zero matches within `apps/server/src/services/agent-sessions.ts`
