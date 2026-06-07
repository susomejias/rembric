## ADDED Requirements

### Requirement: `memory.context` MUST display-truncate every text field to one shared bound

The `memory.context` handler (`handleContext` in `apps/server/src/mcp/sessions-tools.ts`) SHALL NOT emit any stored long-form text verbatim. Every text field of its response SHALL be display-truncated through the same `snippet(content, max)` helper, using a single module-level bound `CONTEXT_SNIPPET_CHARS`, producing a value of at most `CONTEXT_SNIPPET_CHARS` characters with a trailing `…` ellipsis when truncation occurs. The fields covered are:

- `recentSessions[].summary`
- `recentPrompts[].content`
- `recentMemories[].snippet`
- `pendingJudgments[].sourceSnippet` and `pendingJudgments[].targetSnippet`

The four fields SHALL share the one constant; no per-field literal truncation length SHALL remain in `handleContext`.

This is a read-side display concern only. It SHALL NOT alter what is stored: the `sessions.summary` column, the `SUMMARY_MAX_CHARS = 2000` write cap, the `summary_final` precedence rule, prompt rows, and memory rows are all unaffected. The full values SHALL remain retrievable verbatim through every other surface (`memory.get`, the dashboard, and any read path that returns a row directly).

A `NULL` stored session summary SHALL be emitted as `null` (not coerced to an empty snippet). The default recent-session count SHALL remain `5` — this requirement governs per-field size, not item count.

#### Scenario: A session summary longer than the bound is truncated in context

- **GIVEN** a content-bearing session whose stored `summary` is longer than `CONTEXT_SNIPPET_CHARS`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL be at most `CONTEXT_SNIPPET_CHARS` characters
- **AND** it SHALL end with the `…` ellipsis character

#### Scenario: A short session summary passes through unchanged

- **GIVEN** a content-bearing session whose stored `summary` is shorter than `CONTEXT_SNIPPET_CHARS`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL equal the stored value verbatim
- **AND** it SHALL NOT contain a trailing `…` ellipsis

#### Scenario: A session with no summary yields null

- **GIVEN** a content-bearing session whose stored `summary IS NULL` (it satisfies `sessionHasContent` via anchored rows)
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL be `null`

#### Scenario: Prompt content is bounded by the same constant

- **GIVEN** a recent user prompt whose stored `content` is longer than `CONTEXT_SNIPPET_CHARS`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentPrompts[].content` SHALL be at most `CONTEXT_SNIPPET_CHARS` characters ending with `…`

#### Scenario: Storage and other read paths are unaffected

- **GIVEN** a session whose `summary` was truncated to a snippet in a `memory.context` response
- **WHEN** the same session's row is read through a path that returns the summary directly (e.g. the agent-sessions service `getById` or the dashboard sessions view)
- **THEN** the full, untruncated stored `summary` SHALL be returned
