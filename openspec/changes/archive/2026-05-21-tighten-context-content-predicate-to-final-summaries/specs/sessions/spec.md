## ADDED Requirements

### Requirement: `sessionIsContextWorthy` is the surfacing predicate for `memory.context`

`AgentSessionsService` SHALL define an internal SQL predicate, `sessionIsContextWorthy(s)`, returning TRUE for a `sessions` row `s` iff at least ONE of the following holds:

1. `s.summary IS NOT NULL` AND `s.summary_final = 1`, OR
2. `s.title_final = 1`.

The predicate SHALL be implemented as a single private SQL-fragment helper inside `apps/server/src/services/agent-sessions.ts`. It SHALL have exactly ONE consumer: `recentForContext`. It expresses the question "is this session worth surfacing to the LLM as a `recentSessions` entry?"

`sessionIsContextWorthy(s)` is a strict subset of `sessionHasContent(s)`: every context-worthy session is also content-bearing, but content-bearing sessions are not necessarily context-worthy. The distinction is intentional — purge protection and surfacing eligibility ask different questions:

- Purge protection asks "would deleting this row dangle foreign keys?" (`sessionHasContent`).
- Surfacing asks "does this row carry signal the LLM can read directly?" (`sessionIsContextWorthy`).

The two predicates SHALL coexist in the same source file and SHALL be the ONLY places where their respective SQL clauses are expressed.

#### Scenario: A session with a curated summary satisfies `sessionIsContextWorthy`

- **GIVEN** session `S` with `summary = 'Goal: …'` and `summary_final = 1`
- **WHEN** `sessionIsContextWorthy(S)` is evaluated
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with `title_final = 1` satisfies `sessionIsContextWorthy`

- **GIVEN** session `S` with `summary IS NULL` and `title_final = 1`
- **WHEN** `sessionIsContextWorthy(S)` is evaluated
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with anchored memory but no curated summary is content-bearing but not context-worthy by itself

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, AND at least one row in `memory` referencing `S.id`, evaluated BEFORE any terminal transition fires the auto-curate (e.g. mid-flight or status='active')
- **WHEN** `sessionHasContent(S)` and `sessionIsContextWorthy(S)` are both evaluated
- **THEN** `sessionHasContent(S)` SHALL return TRUE (purge-protected) AND `sessionIsContextWorthy(S)` SHALL return FALSE
- **AND** after the terminal transition fires, the auto-curate path SHALL elevate `S` to context-worthy by writing a derived summary (see `Auto-curate at terminal transition` requirement below)

#### Scenario: A session with only a transcript-fallback summary is neither content-bearing nor context-worthy

- **GIVEN** session `S` with `summary = '<raw transcript dump>'`, `summary_final = 0`, `title_final = 0`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** `sessionHasContent(S)` and `sessionIsContextWorthy(S)` are both evaluated
- **THEN** both SHALL return FALSE — the row is purgeable AND it does not surface to the LLM (the auto-curate path also does NOT fire, since there is no anchored content to derive from)

### Requirement: Server-side auto-curate at terminal transition

When `AgentSessionsService.end(sessionId)` or `AgentSessionsService.abandonStale()` transitions a session from `active` to a terminal status (`ended` or `abandoned`), the service SHALL, in the same transaction:

1. Read the current `summary_final` flag.
2. If `summary_final = 1`, SKIP — the agent already curated, the curated text wins, no overwrite.
3. If `summary_final = 0` AND the session has at least one anchored row in `memory`, `prompts`, OR `confirmations`, COMPOSE a derived summary using the deterministic template defined below and WRITE it to the row with `summary_final = 1`.
4. If `summary_final = 0` AND the session has NO anchored content, SKIP — there is nothing to derive from. The session remains non-context-worthy and operator-purgeable.

The derivation template is the pure function `composeDerivedSummary(counts, lastMemoryContent)`:

```
parts := []
if counts.memories > 0:      parts.push(`${counts.memories} memorias`)
if counts.prompts > 0:       parts.push(`${counts.prompts} prompts`)
if counts.confirmations > 0: parts.push(`${counts.confirmations} confirmaciones`)

head := join(parts, ', ')
tail := lastMemoryContent ? ` — última: '${snippet(lastMemoryContent, 80)}'` : ''

return `[auto] ${head}${tail}`
```

The function SHALL be deterministic: same `counts` and `lastMemoryContent` produce the same output, byte-for-byte. The function SHALL NOT inspect the previous `summary` value, SHALL NOT call any LLM, SHALL NOT apply heuristics over the content. The `[auto]` prefix is mandatory and identifies the row as server-derived to both the agent and the operator.

The auto-curate write SHALL OVERWRITE any prior `final:false` `summary` value (a per-turn transcript dump written by a plugin Stop hook). The derived summary supersedes the transcript dump in the `summary` column; operators retain forensic visibility of anchored content via `/dashboard/sessions/:id` (the memories list, prompts list, and timing).

The auto-curate path SHALL be the SECOND writer that can lift `summary_final` to 1 (the first being the MCP tool `memory.session_summary`). Subsequent agent-issued `memory.session_summary` calls SHALL be able to overwrite an auto-curated row (see the modified `writeSummary` precedence below): agent intent always wins over server-derived content.

`countPurgeableEmpty` and `purgeEmpty` SHALL keep using `sessionHasContent` (5 clauses); auto-curated sessions naturally fail the `NOT sessionHasContent` predicate (their EXISTS-anchored content was the reason they were curated), so they are NOT purge-eligible.

#### Scenario: Agent curated before ending — auto-curate is a no-op

- **GIVEN** active session `S` with `summary_final = 1` (agent called `memory.session_summary` earlier)
- **WHEN** the agent calls `memory.session_end` on `S`
- **THEN** the service SHALL transition `S` to `ended` and SHALL NOT overwrite the curated summary
- **AND** `S.summary_final` SHALL remain 1, `S.summary` SHALL remain the agent's curated text

#### Scenario: Agent did not curate, session has anchored memory — auto-curate fires

- **GIVEN** active session `S` with `summary_final = 0`, `summary IS NULL` (or any non-final summary), and 5 anchored rows in `memory`, latest content `"Fixed null check in foo.ts when handler receives undefined"`
- **WHEN** the agent calls `memory.session_end` on `S`
- **THEN** the service SHALL atomically: set `status = 'ended'`, write `summary = "[auto] 5 memorias — última: 'Fixed null check in foo.ts when handler receives undefined'"`, set `summary_final = 1`, set `ended_at = now`
- **AND** `S` SHALL now satisfy `sessionIsContextWorthy` and surface in `memory.context.recentSessions`

#### Scenario: Agent did not curate, session has only transcript dump — auto-curate skips

- **GIVEN** active session `S` with `summary = '<raw transcript dump>'`, `summary_final = 0`, and zero anchored rows
- **WHEN** the agent calls `memory.session_end` on `S`
- **THEN** the service SHALL transition `S` to `ended` and SHALL NOT touch `summary` or `summary_final`
- **AND** `S` SHALL remain non-context-worthy (excluded from `memory.context.recentSessions`) and SHALL become purge-eligible after the 1h `ended_at` grace

#### Scenario: abandonStale transitions also trigger auto-curate

- **GIVEN** an active session `S` with `summary_final = 0`, 8 anchored memory rows, and `started_at` older than the abandonStale cutoff
- **WHEN** `abandonStale({olderThanMs})` runs (typically at server startup)
- **THEN** the service SHALL per-row: apply the auto-curate write (composing the derived summary) AND transition `status` to `abandoned` AND set `ended_at = now` — in a single transaction per session
- **AND** the returned `{ abandoned: N }` count SHALL match the number of sessions transitioned

#### Scenario: Auto-curate output is deterministic and structural

- **GIVEN** a session `S` with anchored counts `{ memories: 3, prompts: 2, confirmations: 0 }` and latest memory content `"Refactored the auth middleware to use jose"`
- **WHEN** `composeDerivedSummary` is called with those inputs
- **THEN** the output SHALL be exactly `"[auto] 3 memorias, 2 prompts — última: 'Refactored the auth middleware to use jose'"` — same input always produces same output, no LLM, no heuristic, no content inspection of the previous summary

### Requirement: `writeSummary` MUST allow `final:true` writes on terminal sessions

`AgentSessionsService.writeSummary(sessionId, input)` SHALL accept the write under either of two conditions, relaxing the previous "active-only" gate so that agents can override server auto-curated rows. The service is the shared entry point for both the MCP tool `memory.session_summary` (always `final:true`) and the HTTP fallback path `POST /api/<slug>/sessions/:id/summary` (always `final:false` after hardening).

The two acceptance conditions are:

1. The session's `status = 'active'` (the historical pre-existing rule), OR
2. The session's `status ∈ {'ended', 'abandoned'}` AND the incoming `input.final === true` — i.e., the agent is explicitly issuing a curated write on a terminal session.

Condition (2) exists so that an agent can OVERRIDE a server auto-curated row with its own curated summary at any point, including after the session has already transitioned. The HTTP fallback path cannot exploit this opening because the HTTP handlers hard-code `final: false`, so the HTTP-derived writes still hit condition (1)'s `status = 'active'` gate — only the MCP tool `memory.session_summary` can satisfy condition (2).

When the write is accepted under condition (2), the precedence rule applies as usual: `summary` (and optionally `title`) are overwritten, `summary_final` (and `title_final`) are set to 1, `status`/`ended_at` are NOT modified.

When the incoming write is `final:false` on a terminal session (HTTP path or otherwise), the call SHALL be rejected with `session_already_ended`.

#### Scenario: Agent overrides an auto-curated ended session via `memory.session_summary`

- **GIVEN** session `S` is `ended` with `summary = '[auto] 5 memorias — última: …'` and `summary_final = 1` (server auto-curated)
- **WHEN** the agent calls `memory.session_summary({summary: 'Goal: X. Files: Y.', title: 'Refactor'})` against `S`
- **THEN** the server SHALL accept the write (condition 2)
- **AND** `S.summary` SHALL become `'Goal: X. Files: Y.'`, `S.title` SHALL become `'Refactor'`, `S.summary_final` SHALL remain 1, `S.title_final` SHALL become 1
- **AND** `S.status` SHALL remain `'ended'` (unchanged)

#### Scenario: HTTP fallback cannot exploit the relaxation

- **GIVEN** an ended session `S`
- **WHEN** an HTTP client POSTs `{summary: 'transcript', final: true}` to `/api/<slug>/sessions/:id/summary` (the body's `final` field is dropped by the zod schema and the handler hard-codes `false`)
- **THEN** the service-level call is `writeSummary(S, {final: false})`, which fails condition (1) (`status != 'active'`) and condition (2) (`final !== true`), and SHALL be rejected with `session_already_ended`

#### Scenario: `final:true` write on an active session is unchanged

- **GIVEN** an active session `S` with `summary_final = 0`
- **WHEN** the agent calls `memory.session_summary({summary: 'Goal: X'})` (the MCP handler injects `final: true`)
- **THEN** the write is accepted under condition (1) and `S.summary_final` becomes 1, exactly as before this change

## MODIFIED Requirements

### Requirement: `sessionHasContent` is the single source-of-truth predicate for "this session is worth surfacing"

`AgentSessionsService` SHALL define an internal SQL predicate, `sessionHasContent(s)`, returning TRUE for a `sessions` row `s` iff at least ONE of the following holds:

1. `s.summary IS NOT NULL`, OR
2. `s.title_final = 1`, OR
3. there exists at least one row in `memory` with `session_id = s.id`, OR
4. there exists at least one row in `prompts` with `session_id = s.id` AND `deleted_at IS NULL`, OR
5. there exists at least one row in `confirmations` with `session_id = s.id`.

This predicate governs **purge eligibility only**. It answers "would physically deleting this row dangle foreign-key references?" — and so any anchored content (memory / prompts / confirmations) keeps a session out of the purge set, regardless of whether the agent curated it. Surfacing to `memory.context` is governed by the separate, stricter predicate `sessionIsContextWorthy`.

Soft-deleted prompts (`deleted_at IS NOT NULL`) DO NOT make a session content-bearing; the operator has already marked them as obsolete.

The predicate SHALL be implemented as a single private SQL-fragment helper inside `apps/server/src/services/agent-sessions.ts`. It SHALL be the ONLY place in the codebase where this five-clause predicate is expressed. The `countPurgeableEmpty` and `purgeEmpty` methods SHALL consume the predicate in negated form (`NOT sessionHasContent(s)`) as part of their "purgeable" check. `recentForContext` SHALL NOT consume this predicate — it consumes `sessionIsContextWorthy` instead.

When a future content-bearing table is added with a `session_id` foreign key (the canonical example being a hypothetical `tool_calls` table), the predicate SHALL be the single point of update for the purge protection — the new EXISTS clause is added once, and `countPurgeableEmpty` / `purgeEmpty` pick the change up automatically.

#### Scenario: A session with a written summary satisfies the predicate

- **GIVEN** session `S` with `summary = 'Goal: ...'` and no anchored memory/prompt/confirmation rows
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return TRUE

#### Scenario: A session with no content fails the predicate

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** any call site evaluates `sessionHasContent(S)`
- **THEN** the predicate SHALL return FALSE

#### Scenario: A session with anchored memory is content-bearing even without curated summary

- **GIVEN** session `S` with `summary IS NULL`, `title_final = 0`, and at least one anchored row in `memory` with `session_id = S.id`
- **WHEN** `sessionHasContent(S)` is evaluated
- **THEN** the predicate SHALL return TRUE — the session is purge-protected to preserve referential integrity of the anchored memory

#### Scenario: Strict-subset relationship with `sessionIsContextWorthy`

- **GIVEN** the codebase as a whole
- **WHEN** a reviewer reads both predicate helpers
- **THEN** every clause of `sessionIsContextWorthy(s)` SHALL imply at least one clause of `sessionHasContent(s)` (a curated summary implies non-null summary; `title_final = 1` is a clause of `sessionHasContent` verbatim)
- **AND** a code search for the EXISTS-bearing 5-clause predicate SHALL return zero matches outside the `sessionHasContent` helper definition within `apps/server/src/services/agent-sessions.ts`

### Requirement: `recentForContext` MUST exclude empty sessions by default

`AgentSessionsService.recentForContext({projectId, limit})` SHALL return at most `limit` rows, ordered by `started_at DESC`, drawn from the set of sessions satisfying ALL of:

1. `deleted_at IS NULL` (soft-delete);
2. scope match (`projectId IS NULL` for global, or `project_id = ?` for path-scoped);
3. `sessionIsContextWorthy(s)` is TRUE.

Filtering SHALL precede truncation: a request with `limit: 5` SHALL return the five most-recent _context-worthy_ sessions, even if dozens of newer non-curated sessions exist between them. Non-curated sessions SHALL NEVER consume a slot in the response.

The method SHALL NOT accept any flag, option, or argument that bypasses the `sessionIsContextWorthy` filter. Operators who need to inspect non-curated sessions SHALL use `/dashboard/sessions`, which surfaces all rows regardless of curation.

Note: after the auto-curate path lands (see ADDED requirement above), most real-work sessions naturally become context-worthy at their terminal transition, so the population of `sessionIsContextWorthy(s) = TRUE` is the union of agent-curated rows AND server-auto-curated rows. The `[auto]` prefix on the latter is informational only; the predicate does not inspect the summary text.

#### Scenario: A non-curated session is excluded BEFORE terminal transition

- **GIVEN** an active session `M` with `summary_final = 0` AND one anchored memory row referencing `M.id`, plus an ended session `C` with `summary_final = 1`
- **WHEN** `recentForContext({projectId, limit: 5})` is called BEFORE `M` transitions to terminal
- **THEN** the result SHALL contain `C` and SHALL NOT contain `M`
- **AND** `M`'s memory still appears in the caller's `recentMemories[]` payload via `MemoryService.recentForContext`

#### Scenario: A non-curated session with anchored content surfaces AFTER terminal transition (auto-curate)

- **GIVEN** a session `M` that has 5 anchored memory rows but was never explicitly curated by the agent
- **WHEN** the agent calls `memory.session_end` on `M`, which fires the auto-curate path, AND THEN `recentForContext({projectId, limit: 5})` is called
- **THEN** the result SHALL contain `M` with `summary` matching the deterministic `[auto] N memorias…` template

#### Scenario: A non-curated session with no anchored content is excluded permanently

- **GIVEN** an ended session `T` with `summary_final = 0`, zero anchored rows, optionally with a non-final transcript dump in `summary`
- **WHEN** `recentForContext({projectId, limit: 5})` is called
- **THEN** `T` SHALL NOT appear in the result — auto-curate did not fire (no anchored content), the row stays non-context-worthy permanently

#### Scenario: Filter-then-truncate produces backfill semantics

- **GIVEN** a scope containing, in `started_at` order from newest to oldest: three non-curated sessions `A`, `B`, `C` (none with anchored content) and one curated session `U`
- **WHEN** `recentForContext({projectId, limit: 1})` is called
- **THEN** the result SHALL be `[U]` — the most-recent CURATED session, not the most-recent session overall

#### Scenario: Soft-deleted session with curated summary is still excluded

- **GIVEN** a session that has `summary_final = 1` AND is soft-deleted
- **WHEN** `recentForContext` is called
- **THEN** the row SHALL NOT appear in the result — both filters apply, neither overrides the other

