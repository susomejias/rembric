## RENAMED Requirements

- FROM: `### Requirement: `memory.context` MUST display-truncate every text field to one shared bound`
- TO: `### Requirement: `memory.context` MUST display-truncate every text field to a named bound`

## MODIFIED Requirements

### Requirement: `memory.context` MUST display-truncate every text field to a named bound

The `memory.context` handler (`handleContext` in `packages/mcp/src/memory-tools.ts`) SHALL NOT emit any stored long-form text verbatim. Every text field of its response SHALL be display-truncated through the same `snippet(content, max)` helper, producing a value of at most `max` characters with a trailing `…` ellipsis when truncation occurs. Two module-level bounds exist and no per-field literal truncation length SHALL remain in `handleContext`:

- `CONTEXT_SNIPPET_CHARS` (350) bounds `recentPrompts[].content`, `recentMemories[].snippet`, `pendingJudgments[].sourceSnippet` and `pendingJudgments[].targetSnippet`, and `recentSessions[].summary` whenever that summary carries no pending work.
- `CONTEXT_PENDING_CHARS` (600) bounds `recentSessions[].summary` when the summary carries pending work.

A summary carries pending work when it has a `## Unfinished+why` section, parsed by the same section rules as the summary merge, whose body is not empty after trimming and is not only a statement that nothing is pending: `none`, `nothing`, `n/a`, `nada`, `ninguna`, `ninguno`, `—` or `-`, case-insensitive and optionally followed by a period. For such a summary, `recentSessions[].summary` SHALL be that section's heading line, a line break and its trimmed body, in place of the summary's opening. Every other summary SHALL be emitted from its opening, as before. The reason is that the opening holds `## Goal`, which the session `title` already names, while the pending section is the part a later session must act on, and no other `memory.context` field carries it.

This is a read-side display concern only. It SHALL NOT alter what is stored: the `sessions.summary` column, the `SUMMARY_MAX_CHARS` write cap, the `summary_final` precedence rule, prompt rows, and memory rows are all unaffected. The full values SHALL remain retrievable verbatim through every other surface (`memory.session_get_batch`, `memory.get_batch`, the dashboard, and any read path that returns a row directly).

A `NULL` stored session summary SHALL be emitted as `null` (not coerced to an empty snippet). The default recent-session count SHALL remain `3` — this requirement governs per-field size, not item count.

`recentSessions[]` SHALL additionally include a `title` field, emitted **verbatim** as stored (`s.title`) — the curated title when the agent set one via `memory.session_summary`, otherwise the auto-generated placeholder. `title` is bounded to ≤100 chars at write time, so it is a short label emitted as-is and is NOT passed through the snippet helper. No filtering or hiding logic SHALL be applied: a populated title is emitted as-is, and a `null` stored title (should one ever occur) is emitted as `null`.

The `memory.context` tool description SHALL state that a recent-session summary snippet shows the `## Unfinished+why` section when it lists pending work, and the opening otherwise.

#### Scenario: A session summary longer than the bound is truncated in context

- **GIVEN** a content-bearing session whose stored `summary` carries no pending work and is longer than `CONTEXT_SNIPPET_CHARS`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL be at most `CONTEXT_SNIPPET_CHARS` characters
- **AND** it SHALL end with the `…` ellipsis character

#### Scenario: A short session summary passes through unchanged

- **GIVEN** a content-bearing session whose stored `summary` carries no pending work and is shorter than `CONTEXT_SNIPPET_CHARS`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL equal the stored value verbatim
- **AND** it SHALL NOT contain a trailing `…` ellipsis

#### Scenario: Pending work replaces the opening under the wider bound

- **GIVEN** a session summary with a 400-character `## Goal` and a `## Unfinished+why` section whose body is 482 characters
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL equal `## Unfinished+why`, a line break and that body, verbatim and without `…`
- **AND** it SHALL be longer than `CONTEXT_SNIPPET_CHARS`

#### Scenario: A long pending section is truncated to the wider bound

- **GIVEN** a session summary whose `## Unfinished+why` body is longer than `CONTEXT_PENDING_CHARS`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL start with `## Unfinished+why`, be exactly `CONTEXT_PENDING_CHARS` characters, and end with `…`

#### Scenario: A section that says nothing is pending keeps the opening

- **GIVEN** a session summary with a 400-character `## Goal` and a `## Unfinished+why` section whose body is `none`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].summary` SHALL start with `## Goal`, be exactly `CONTEXT_SNIPPET_CHARS` characters, and end with `…`

#### Scenario: A body that only starts with a nothing-pending word still counts as pending

- **GIVEN** a `## Unfinished+why` body `None blocking; install.sh still modified, undecided.`
- **WHEN** the pending section is extracted
- **THEN** it SHALL be returned with that body, because only a body consisting of a nothing-pending statement is excluded

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

#### Scenario: A curated session title is surfaced verbatim

- **GIVEN** a session whose title was set via `memory.session_summary({ title })`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].title` SHALL equal the stored title verbatim

#### Scenario: An uncurated session's title is still surfaced verbatim

- **GIVEN** a content-bearing session that was never summarized with a title (only the auto-generated placeholder exists)
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].title` SHALL equal the stored (placeholder) title verbatim — no hiding or nulling logic is applied
