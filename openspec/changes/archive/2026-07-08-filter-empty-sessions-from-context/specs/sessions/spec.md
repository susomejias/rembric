## MODIFIED Requirements

### Requirement: Sessions MAY be soft-deleted while preserving the audit trail

The `agent_sessions` table SHALL gain a nullable column `deleted_at TIMESTAMP`. A row with `deleted_at IS NOT NULL` is _soft-deleted_: it remains physically present, its `id` continues to satisfy every existing `memory.session_id` foreign-key reference, but it is hidden from default-visible listings.

`AgentSessionsService` SHALL expose:

- `softDelete(sessionId, {tokenId?, adminBypass?})`: sets `deleted_at` to `now()`. Calling this on an already-deleted row SHALL be a no-op that returns the existing row (idempotent). Without `adminBypass`, the caller's `tokenId` SHALL match the row's `token_id`; mismatches SHALL be rejected with `forbidden`.
- `undelete(sessionId, {adminBypass?})`: clears `deleted_at`. Only admin (operator-facing) callers may invoke this; agent-facing callers SHALL NOT have access.

`AgentSessionsService.list(...)` SHALL apply `WHERE deleted_at IS NULL` by default. `list(...)` SHALL accept an `includeDeleted: true` option to surface deleted rows. `AgentSessionsService.recentForContext(...)` SHALL apply BOTH `WHERE deleted_at IS NULL` AND the `sessionHasContent` predicate defined below; it SHALL NOT accept any option that bypasses either filter — memory-context callers SHALL never see deleted sessions and SHALL never see empty sessions.

`AgentSessionsService.findById(...)` SHALL NOT filter on `deleted_at` or on `sessionHasContent`. The detail surface must still be able to open and act on (e.g. undelete) any row regardless of content.

#### Scenario: softDelete sets deleted_at and hides the row from default list

- **GIVEN** an active session with `id = <S>` whose `deleted_at` is NULL
- **WHEN** the operator calls `softDelete(<S>, {adminBypass: true})`
- **THEN** the row's `deleted_at` SHALL be set to the current timestamp
- **AND** a subsequent `list()` SHALL NOT include the row
- **AND** a subsequent `list({includeDeleted: true})` SHALL include the row
- **AND** `findById(<S>)` SHALL still return the row

#### Scenario: softDelete is idempotent

- **GIVEN** a session whose `deleted_at` is already set
- **WHEN** the operator calls `softDelete` on it again
- **THEN** the call SHALL succeed and SHALL NOT modify `deleted_at`
- **AND** the returned row SHALL be the existing soft-deleted row

#### Scenario: undelete clears deleted_at

- **GIVEN** a soft-deleted session
- **WHEN** the operator calls `undelete` on it with `adminBypass: true`
- **THEN** `deleted_at` SHALL transition back to NULL
- **AND** the row SHALL re-appear in the default list

#### Scenario: Memories anchored to a soft-deleted session preserve their session_id

- **GIVEN** a memory whose `session_id` references session `<S>`
- **WHEN** session `<S>` is soft-deleted
- **THEN** the memory's `session_id` SHALL remain unchanged and SHALL continue to point at `<S>`

## ADDED Requirements

### Requirement: `sessionHasContent` is the single source-of-truth predicate for "this session is worth surfacing"

`AgentSessionsService` SHALL define an internal SQL predicate, `sessionHasContent(s)`, returning TRUE for a `sessions` row `s` iff at least ONE of the following holds:

1. `s.summary IS NOT NULL`, OR
2. `s.title_final = 1`, OR
3. there exists at least one row in `memory` with `session_id = s.id`, OR
4. there exists at least one row in `prompts` with `session_id = s.id`, OR
5. there exists at least one row in `confirmations` with `session_id = s.id`.

The predicate SHALL be implemented as a single private SQL-fragment helper inside `apps/server/src/services/agent-sessions.ts`. It SHALL be the ONLY place in the codebase where this five-clause predicate is expressed. The `countPurgeableEmpty` and `purgeEmpty` methods SHALL consume the predicate in negated form (`NOT sessionHasContent(s)`) as part of their "purgeable" check. `recentForContext` SHALL consume the predicate in positive form as part of its "is useful to surface" check.

When a future content-bearing table is added with a `session_id` foreign key (the canonical example being a hypothetical `tool_calls` table), the predicate SHALL be the single point of update — the new EXISTS clause is added once, and every call site picks it up automatically.

#### Scenario: A session with a written summary satisfies the predicate

- **GIVEN** session `S` with `summary = 'Goal: ...'` and no anchored memory/prompt/confirmation rows
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with no content fails the predicate

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return FALSE

#### Scenario: Drift between purge predicate and context predicate is impossible

- **GIVEN** the codebase as a whole
- **WHEN** any reviewer reads `countPurgeableEmpty`, `purgeEmpty`, and `recentForContext`
- **THEN** each SHALL reference `sessionHasContent` rather than inlining its five clauses
- **AND** a code search for `EXISTS (SELECT 1 FROM memory WHERE session_id` outside the helper definition SHALL return zero matches within `apps/server/src/services/agent-sessions.ts`

### Requirement: `recentForContext` MUST exclude empty sessions by default

`AgentSessionsService.recentForContext({projectId, limit})` SHALL return at most `limit` rows, ordered by `started_at DESC`, drawn from the set of sessions satisfying ALL of:

1. `deleted_at IS NULL` (soft-delete already specified above);
2. scope match (`projectId IS NULL` for global, or `project_id = ?` for path-scoped);
3. `sessionHasContent(s)` is TRUE.

Filtering SHALL precede truncation: a request with `limit: 5` SHALL return the five most-recent _useful_ sessions, even if dozens of newer empty sessions exist between them. Empty sessions SHALL NEVER consume a slot in the response.

The method SHALL NOT accept any flag, option, or argument that bypasses the `sessionHasContent` filter. Operators who need to inspect empty sessions SHALL use `/dashboard/sessions`, which surfaces all rows regardless of content.

#### Scenario: An empty active session is excluded

- **GIVEN** a scope containing one active session `A` with no summary and zero anchored rows, plus one ended session `E` with a summary
- **WHEN** `recentForContext({projectId, limit: 5})` is called
- **THEN** the result SHALL contain `E` and SHALL NOT contain `A`

#### Scenario: Filter-then-truncate produces backfill semantics

- **GIVEN** a scope containing, in `started_at` order from newest to oldest: three empty sessions `A`, `B`, `C` and one useful session `U`
- **WHEN** `recentForContext({projectId, limit: 1})` is called
- **THEN** the result SHALL be `[U]` — the most-recent USEFUL session, not the most-recent session overall

#### Scenario: Soft-deleted session with content is still excluded

- **GIVEN** a session that has a summary AND is soft-deleted
- **WHEN** `recentForContext` is called
- **THEN** the row SHALL NOT appear in the result — both filters apply, neither overrides the other
