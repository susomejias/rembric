# mcp-api — delta for remove-llm-consolidation

## MODIFIED Requirements

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ recentSessions, recentPrompts, recentMemories, pendingJudgments }`, with each list scoped to the request context (global vs path-scoped project)
- **AND** `recentSessions` SHALL contain only sessions that satisfy the `sessionHasContent` predicate (see `sessions` capability), ordered by `started_at DESC`, with empty sessions filtered out BEFORE truncation to `sessions ?? 5`
- **AND** `recentPrompts` SHALL be ordered by `created_at DESC` and filtered to `deleted_at IS NULL`
- **AND** `recentMemories` SHALL be ordered by `last_seen_at DESC` with `includeArchived = false` (default) filtering out `status = 'archived'` rows
- **AND** `pendingJudgments` SHALL contain at most 5 pending relations in scope with `created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)`, oldest first, each entry carrying `{ judgmentId, sourceId, targetId, sourceSnippet, targetSnippet, ageMs }` so the agent can close them with `memory.judge` without further reads

#### Scenario: `memory.context.recentSessions` backfills past empty sessions

- **GIVEN** the active scope contains, in `started_at` order from newest to oldest, three empty sessions and one useful session
- **WHEN** an MCP client calls `memory.context({sessions: 1})`
- **THEN** the response's `recentSessions` array SHALL have length 1 and SHALL contain only the useful session — the three newer empty sessions SHALL NOT consume the slot

#### Scenario: `memory.context.recentSessions` excludes soft-deleted sessions

- **GIVEN** a session that has content AND is soft-deleted (`deleted_at IS NOT NULL`)
- **WHEN** an MCP client calls `memory.context`
- **THEN** the row SHALL NOT appear in `recentSessions` — the soft-delete filter and the content filter both apply

#### Scenario: `memory.context` arguments exceed clamps

- **WHEN** the caller passes `sessions > 25`, `prompts > 50`, or `memories > 100`
- **THEN** the server SHALL silently clamp to the maximum and SHALL include a `clamped: true` field in the response

#### Scenario: `memory.context` excludes soft-deleted prompts

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** an MCP client calls `memory.context`
- **THEN** `recentPrompts` SHALL include `P1` and SHALL NOT include `P2`

#### Scenario: `memory.context` exposes only aged pendings, never fresh ones

- **GIVEN** a pending relation younger than `JUDGMENT_ORPHAN_AFTER_MS` and another older than it, both in scope
- **WHEN** an MCP client calls `memory.context`
- **THEN** `pendingJudgments` SHALL include only the aged one — fresh pendings belong to the session that created them

#### Scenario: `memory.context.pendingJudgments` respects scope

- **GIVEN** an aged pending relation whose memories belong to project B
- **WHEN** an MCP client scoped to project A calls `memory.context`
- **THEN** `pendingJudgments` SHALL NOT include it

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

### Requirement: The MCP server MUST expose two observability tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`.

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { open, journalMode, integrity, sizeBytes }, embeddings: { enabled, backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, warnings: string[] }` — the report SHALL NOT contain an `llm` block

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ memoriesByStatus, memoriesByType, memoriesByScope, sessionsByStatus, totalProjects, totalTokens }` with each value being a `Record<string, number>` of counts scoped to the request context

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*` or `read:project:<id>`
- **THEN** both tools SHALL succeed (they are read-only by design)
