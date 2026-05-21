## MODIFIED Requirements

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ recentSessions, recentPrompts, recentMemories }`, with each list scoped to the request context (global vs path-scoped project)
- **AND** `recentSessions` SHALL contain only sessions that satisfy the `sessionIsContextWorthy` predicate (see `sessions` capability), ordered by `started_at DESC`, with non-curated sessions filtered out BEFORE truncation to `sessions ?? 5`
- **AND** every row in `recentSessions` SHALL have either `summary_final = 1` or `title_final = 1` — set exclusively by the MCP tool `memory.session_summary`
- **AND** `recentPrompts` SHALL be ordered by `created_at DESC` and filtered to `deleted_at IS NULL`
- **AND** `recentMemories` SHALL be ordered by `last_seen_at DESC` with `includeArchived = false` (default) filtering out `status = 'archived'` rows

#### Scenario: `memory.context.recentSessions` backfills past non-curated sessions

- **GIVEN** the active scope contains, in `started_at` order from newest to oldest, three non-curated sessions and one curated session
- **WHEN** an MCP client calls `memory.context({sessions: 1})`
- **THEN** the response's `recentSessions` array SHALL have length 1 and SHALL contain only the curated session — the three newer non-curated sessions SHALL NOT consume the slot

#### Scenario: `memory.context.recentSessions` excludes soft-deleted sessions

- **GIVEN** a curated session that is soft-deleted (`deleted_at IS NOT NULL`)
- **WHEN** an MCP client calls `memory.context`
- **THEN** the row SHALL NOT appear in `recentSessions` — the soft-delete filter and the context-worthy filter both apply

#### Scenario: `memory.context.recentSessions` excludes sessions whose only summary is a transcript fallback

- **GIVEN** a session `S` whose only content is a per-turn transcript write with `summary_final = 0`, no curated summary, no `title_final = 1`, and zero anchored rows in `memory`, `prompts`, `confirmations`
- **WHEN** an MCP client calls `memory.context`
- **THEN** `S` SHALL NOT appear in `recentSessions`
- **AND** `S` SHALL remain visible to operators on `/dashboard/sessions` and eligible for purge via `/dashboard/maintenance` (subject to the existing 1h `ended_at` grace)

#### Scenario: `memory.context.recentSessions` excludes ACTIVE non-curated sessions with anchored memory

- **GIVEN** an active session `S` with `summary_final = 0` AND at least one anchored row in `memory` with `session_id = S.id`
- **WHEN** an MCP client calls `memory.context` BEFORE `S` transitions to a terminal status
- **THEN** `S` SHALL NOT appear in `recentSessions` — the anchored memory keeps `S` safe from purge but does not promote an active row to context-worthy by itself
- **AND** the anchored memory SHALL appear in `recentMemories[]` (with its `session_id` available for `memory.timeline` follow-up)

#### Scenario: `memory.context.recentSessions` includes auto-curated terminal sessions

- **GIVEN** a session `S` that ended with anchored content but no agent-issued curation (server auto-curate fired at `memory.session_end`, producing `summary = '[auto] N memorias — última: …'` and `summary_final = 1`)
- **WHEN** an MCP client calls `memory.context`
- **THEN** `S` SHALL appear in `recentSessions` with the `[auto]`-prefixed summary
- **AND** the agent MAY override the auto-curated summary at any later point via `memory.session_summary` (see `sessions::writeSummary MUST allow final:true on terminal sessions`)

#### Scenario: `memory.context` arguments exceed clamps

- **WHEN** the caller passes `sessions > 25`, `prompts > 50`, or `memories > 100`
- **THEN** the server SHALL silently clamp to the maximum and SHALL include a `clamped: true` field in the response

#### Scenario: `memory.context` excludes soft-deleted prompts

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** an MCP client calls `memory.context`
- **THEN** `recentPrompts` SHALL include `P1` and SHALL NOT include `P2`

#### Scenario: `memory.timeline` returns chronological neighbors within a session

- **WHEN** an MCP client calls `memory.timeline` with `{ memoryId, before?: 5, after?: 5 }` and the target memory has a non-null `session_id`
- **THEN** the server SHALL return up to `before` memories with `created_at < target.created_at` and `session_id = target.session_id`, plus up to `after` memories with `created_at > target.created_at` and `session_id = target.session_id`, ordered chronologically

#### Scenario: `memory.timeline` falls back when the target has no session

- **WHEN** the target memory has `session_id = NULL`
- **THEN** the server SHALL return neighbors selected by `created_at` within ±2 hours of the target's `created_at`, scoped to the same `(scope, project_id)`, and the response SHALL include `fallback: 'time_window'`

#### Scenario: `memory.timeline` combined window exceeds 50

- **WHEN** `before + after > 50`
- **THEN** the call SHALL be rejected with code `invalid_input` and a message referring the caller to `memory.search`

#### Scenario: `memory.capture_passive` extracts numbered learnings

- **WHEN** an MCP client calls `memory.capture_passive` with `{ text: string, sessionId?: string }` and `text` contains a section starting with `^## Key Learnings:\s*$`
- **THEN** the server SHALL extract each subsequent numbered (`1.`, `2.`) or bulleted (`-`, `*`) item, save each as a separate memory with `type = 'discovery'` and the active scope, and SHALL return `{ saved: number, ids: string[] }`

#### Scenario: `memory.capture_passive` finds no learnings block

- **WHEN** the input text has no matching `## Key Learnings:` heading
- **THEN** the server SHALL return `{ saved: 0, ids: [] }` and SHALL NOT error
