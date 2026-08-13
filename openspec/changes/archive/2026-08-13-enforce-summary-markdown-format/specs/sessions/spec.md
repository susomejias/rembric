## MODIFIED Requirements

### Requirement: A session summary MUST follow the documented structure

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted in the session row's `summary` column. The server SHALL NOT enforce the layout — agents may submit free-form text — but the canonical structure SHALL be documented, and it SHALL be documented from ONE definition.

The canonical structure SHALL consist of exactly these Markdown level-2 headings, in this order, each on its own line: `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`. The instruction SHALL explicitly say that they are exact level-2 headings on separate lines and SHALL NOT present bare section names as one dot-separated paragraph. The headings carry: the goal the session was pursuing; the work actually accomplished; the decisions taken and the reason for each; what was verified and by what means; what was left unfinished or blocked, and why; and the files that matter. A structure that names only outcomes produces a summary a later reader cannot act on: the reason a decision was taken and the evidence a claim rests on are the parts that do not survive in the code.

The canonical structure SHALL have a single source of truth in the server, exported as a named constant, and every surface that states it to a model SHALL derive or fixture-pin its text from that definition rather than invent a client-specific list. A test SHALL enumerate those surfaces and SHALL fail when one carries text the constant does not, omits or reorders a heading, appends a heading, or restores the flat dot-separated form. This requirement exists because agreement on section names is insufficient when all agreeing surfaces teach Markdown that renders as one paragraph.

Every model-facing surface, including the `memory.session_summary` tool description, SHALL carry the exact heading directive. Longer reasons/evidence guidance MAY remain concentrated in the end-of-turn rubric, but the bounded tool description has sufficient room for the six headings and separate-line instruction within the host truncation ceiling documented in `mcp-api`.

**The summary a model is asked for is the session's CURRENT COMPLETE state, not the delta since its last write.** The curated write replaces the stored value — that outcome is unchanged and is stated in this capability's cap and precedence requirements — so a write that carries only recent work makes the stored summary carry only recent work. Every model-facing surface SHALL therefore ask for a summary of the state that currently holds for the whole session, concise rather than exhaustive, and SHALL NOT ask for "what changed since last time", "what this window did", or any other delta framing. A model that cannot see its earlier work SHALL be directed to read the stored summary first (`memory.session_get`) rather than to write what it can see.

**The summary SHALL be ordered current-first, and the ordering is a contract rather than a style preference.** `memory.context` emits a session summary truncated to its FIRST `CONTEXT_SNIPPET_CHARS` characters through a head-keeping helper, while `memory.session_get` returns the value in full and untruncated. The head of the stored summary is therefore the preview on which a later model decides whether to fetch the rest, and what a model writes first IS that preview. Surfaces SHALL state this ordering obligation; the server SHALL NOT enforce it, consistent with the layout being unenforced above.

The `memory.session_summary` tool SHALL NOT transition the session to `ended`. The tool writes `summary` (and optionally `title`) only, marking both as `final:true`. The dedicated `memory.session_end` tool (or `POST /sessions/<id>/end`) is the sole transition.

The tool SHALL accept an optional `title?: string` (≤100 chars) which when present SHALL be written to the `title` column with `final:true` precedence.

#### Scenario: `memory.session_summary` is called with a non-empty summary

- **WHEN** the agent submits `{summary: "Goal: …"}` (no title)
- **THEN** the server SHALL set `summary` and `summary_final = true` atomically; `ended_at` and `status` SHALL remain unchanged; the response SHALL be `{ ok: true, sessionId }`

#### Scenario: `memory.session_summary` is called with summary and title

- **WHEN** the agent submits `{summary: "Goal: …", title: "Fix login bug"}`
- **THEN** the server SHALL set `summary`, `summary_final = true`, `title`, and `title_final = true` atomically; `ended_at` and `status` SHALL remain unchanged

#### Scenario: `memory.session_summary` is called with an empty summary

- **WHEN** the agent submits a `summary` string of length 0 or only whitespace
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` is called with a title longer than 100 chars

- **WHEN** the agent submits `{summary: "…", title: "A".repeat(101)}`
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` is called twice; the second call wins because both are final

- **GIVEN** session `<S>` is `active` with summary "A" written via a prior `memory.session_summary` (final:true)
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes)
- **AND** the response SHALL succeed
- **AND** the displaced "A" SHALL remain readable as a version row (see "Every curated session-summary write MUST append a version row in the same transaction") — the replacement is retained, and only its destructiveness is removed

#### Scenario: No model-facing surface asks for a delta

- **WHEN** every surface enumerated by the canonical-structure test is inspected
- **THEN** none SHALL instruct the model to send only what is new, only what changed, or only what the current context window contains
- **AND** each SHALL state that the write replaces the stored summary

#### Scenario: The current-first ordering is stated where the model reads about the tool

- **WHEN** the `memory.session_summary` tool description and the `initialize.instructions` block are inspected
- **THEN** each SHALL state that the current state goes first
- **AND** neither SHALL be over its published length ceiling as a result (`mcp-api`)

#### Scenario: The documented structure uses exact Markdown headings on separate lines

- **WHEN** any model-facing session-summary structure is inspected
- **THEN** it SHALL name exactly `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files` in that order
- **AND** it SHALL direct the model to put each heading on its own line rather than emit `Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files` as one paragraph

#### Scenario: Free-form summary storage remains accepted

- **WHEN** an otherwise-valid `memory.session_summary` call submits non-empty free-form text without the canonical headings
- **THEN** the server SHALL persist it under the ordinary precedence and cap rules rather than reject it for layout
