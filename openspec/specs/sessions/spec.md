# sessions Specification

## Purpose

Defines the session model used to group an agent's tool calls into bounded units of work: append-only lifecycle, scope binding to a single token and at most one project, optional anchoring of memories to a session of origin, summary persistence, explicit-slug overrides, switching constraints, and recovery of in-flight sessions on server restart.

## Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session, EXCEPT through the operator-only physical-purge escape hatch defined in "Sessions MAY be physically purged when empty". Lifecycle changes are otherwise expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, by writing the `ended_at` column at most once **per terminal transition**, and by writing the `summary` and `title` columns subject to the `summary_final` / `title_final` precedence flags.

`ended_at` is write-once per terminal transition rather than write-once per row. It SHALL be written exactly when a row leaves `active` (`end`'s active branch, `markAbandoned`, `abandonInactiveSince`), SHALL be cleared to NULL exactly when a row re-enters `active` through `resume` (see "`AgentSessionsService.resume()` MUST return a terminal session to `active`"), and SHALL NOT be written by any other path. The invariant a reader may rely on is therefore `ended_at IS NOT NULL` if and only if `status <> 'active'`. The instant of a _previous_ terminal transition is NOT retained after a resume; a caller that needs it SHALL read `previousEndedAt` from the resume response, which is the only place it is reported.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `writeSummary`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

The `summary` and `title` columns are exempt from one-write-per-lifetime immutability: they MAY be written multiple times subject to the `final` precedence rules (a `final:true` write locks against `final:false` writes; non-final writes can overwrite each other). This exemption SHALL apply irrespective of `status`, with one narrowing on terminal rows where an already-`final` column becomes immutable — see "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`".

**A fourth class of column exists and SHALL be named rather than left implicit: the OBSERVATION TIMESTAMPS** — `last_activity_at`, `last_work_at`, `last_summary_at`, `last_nudge_at` and `last_turn_report_at`. They record when something was last observed rather than what the session contains, and they are written by many paths and locked by none. **Exactly THREE of the five are MONOTONE and move forward only — `last_work_at`, `last_summary_at` and `last_nudge_at`. `last_activity_at` and `last_turn_report_at` are not, and follow the clock.** Measured at the service boundary with a clock stepped back fifty minutes between two turn reports: both of those two took the earlier instant while `last_work_at` and `last_nudge_at` held their later ones — the control that says the clamp is selective rather than absent. For `last_turn_report_at` the exemption is load-bearing and its own requirement states why (see "Session rows MUST carry the four nudge-gate timestamps, three of them monotone and the turn anchor free to follow the clock") — it is a turn anchor rather than a cumulative observation, and clamping it forward re-arms the gate against the turn that just complied. For `last_activity_at` nothing rests on the ordering and nothing ever has: it feeds the stale-active sweep and transport resolution, where an earlier reading costs at most an early retirement that `resume` reverses. None of the five is lifecycle state: writing one SHALL NOT transition `status`, SHALL NOT write or clear `ended_at`, and SHALL NOT be treated by any reader as evidence that a lifecycle event occurred. This class was previously unenumerated even though `last_activity_at` already belonged to it, which made an append-only reading of this requirement quietly false; naming the class is what lets the nudge-gate columns join it without weakening anything.

#### Scenario: Code path attempts to physically delete a session

- **WHEN** any service or migration emits a `DELETE FROM agent_sessions` statement from any file OTHER than `apps/server/src/services/agent-sessions.ts`
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate an immutable session column

- **WHEN** any service emits an `UPDATE agent_sessions SET agent = ?`, `UPDATE agent_sessions SET started_at = ?`, or `UPDATE agent_sessions SET id = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Two `memory.session_end` (or `/api/.../end`) calls for the same session id

- **WHEN** `memory.session_end` (MCP) or `POST /api/<slug>/sessions/:id/end` (HTTP) is called twice on the same `(token_id, id)`
- **THEN** the second call SHALL succeed as an idempotent no-op (status already `ended`, returns the current row) and SHALL NOT mutate `ended_at`. Summary/title write attempts in the second call SHALL be honoured only if they pass the `final` precedence check.

#### Scenario: `memory.session_end` (or `/api/.../end`) on a row the sweep already abandoned

- **GIVEN** session `<S>` was flipped to `status='abandoned'` with `ended_at = E` by stale-active retirement while its client was still running
- **WHEN** that client calls `memory.session_end` (MCP) or `POST /api/<slug>/sessions/:id/end` (HTTP), with or without summary/title fields
- **THEN** the call SHALL succeed as an idempotent no-op with respect to lifecycle: `status` SHALL remain `'abandoned'` and `ended_at` SHALL remain `E`
- **AND** any summary/title fields in the body SHALL be applied subject to the `final` precedence check
- **AND** the call SHALL NOT be rejected with `session_already_ended`

#### Scenario: deleted_at transitions are tracked

- **WHEN** an operator soft-deletes a session and later undeletes it
- **THEN** `deleted_at` SHALL transition NULL → timestamp → NULL and SHALL be the only column (alongside `summary`/`title`) that may revisit its initial value

#### Scenario: Summary may be updated mid-session subject to final precedence

- **GIVEN** session `<S>` is `active` and `summary` has been written once with `final:false`
- **WHEN** another write lands with `final:false`
- **THEN** the second write SHALL overwrite `summary`
- **AND** `summary_final` SHALL remain `false`

#### Scenario: `ended_at` is cleared when a row re-enters `active`

- **GIVEN** session `<S>` with `status='ended'` and `ended_at = E`
- **WHEN** `resume(<S>, { tokenId })` succeeds
- **THEN** the row SHALL have `status='active'` and `ended_at IS NULL`
- **AND** `E` SHALL NOT be retained on any column of the row
- **AND** a later `end(<S>)` SHALL write a fresh `ended_at` rather than restoring `E`

#### Scenario: An observation timestamp is not a lifecycle write

- **GIVEN** an `active` session `<S>`
- **WHEN** a per-turn report stamps `last_activity_at`, `last_work_at` and `last_nudge_at`
- **THEN** `status` SHALL still be `'active'` and `ended_at` SHALL still be NULL
- **AND** no `summary` or `title` SHALL be written by that stamping alone

### Requirement: `AgentSessionsService.start()` MUST accept a client-provided id and be idempotent on that id

The service method `start(input: { tokenId, projectId, agent, description?, id? })` SHALL accept an optional `id?: string`. When `id` is supplied:

1. The service SHALL validate `id` against the regex `^[A-Za-z0-9_-]{8,128}$`. Non-matching ids SHALL be rejected with `DomainError('invalid_input', <message naming the contract>)`.
2. The service SHALL `SELECT` the row by `id`. If found AND its `token_id` matches the calling token: return the existing row with `created: false` semantics. The service SHALL NOT mutate `status`, `started_at`, `ended_at`, `summary`, `project_id`, `agent`, or `description` on idempotent hits.
3. If the row was found but its `token_id` does NOT match the calling token: throw `DomainError('id_collision', <message>)`. (Theoretically impossible with UUIDs/ULIDs; this is defense-in-depth.)
4. If no row was found: `INSERT` with the provided id and return with `created: true` semantics.

When `id` is NOT supplied, the service SHALL mint a ULID as today and SHALL return `created: true`. This preserves backwards compatibility with `memory.session_start` (MCP) which does not pass an id.

#### Scenario: start() with a valid client id inserts a new row

- **WHEN** `start({ tokenId: 't1', projectId: 'p1', agent: 'claude-code', id: 'sess-abc12345' })` is called and no row exists for id `'sess-abc12345'`
- **THEN** a new row SHALL be inserted with `id = 'sess-abc12345'`, `token_id = 't1'`, `status = 'active'`
- **AND** the returned value SHALL include `created: true`

#### Scenario: start() with the same client id is idempotent for the same token

- **GIVEN** a previous successful `start({ tokenId: 't1', id: 'sess-abc12345', projectId: 'p1' })`
- **WHEN** `start({ tokenId: 't1', id: 'sess-abc12345', projectId: 'p1' })` is called again
- **THEN** the second call SHALL return the existing row with `created: false`
- **AND** `started_at` SHALL be unchanged from the original insert
- **AND** the table SHALL still contain exactly one row for that id

#### Scenario: start() rejects cross-token id collision

- **GIVEN** a row exists for `(token_id='t1', id='shared-id-12345')`
- **WHEN** `start({ tokenId: 't2', id: 'shared-id-12345', projectId: 'p1' })` is called
- **THEN** the service SHALL throw `DomainError('id_collision', ...)` and SHALL NOT insert or mutate any row
- **AND** the original row for `('t1', 'shared-id-12345')` SHALL be untouched

#### Scenario: start() rejects malformed ids

- **WHEN** `start({ tokenId: 't1', id: 'x', projectId: 'p1' })` is called (too short — fails regex)
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)` and SHALL NOT insert a row

- **WHEN** `start({ tokenId: 't1', id: 'has spaces', projectId: 'p1' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)`

- **WHEN** `start({ tokenId: 't1', id: 'A'.repeat(129), projectId: 'p1' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)`

#### Scenario: start() without explicit id preserves ULID-minting behavior

- **WHEN** `start({ tokenId: 't1', projectId: 'p1', agent: 'mcp' })` is called (no `id`)
- **THEN** the service SHALL mint a ULID via `ulid()`, insert, and return a row whose `id` is that ULID
- **AND** the returned value SHALL include `created: true`

### Requirement: A session belongs to exactly one token and at most one project

Every session row SHALL carry a `token_id` referencing an existing row in `tokens`, and SHALL carry the `project_id` its connection resolved to. Because every connection resolves to exactly one project — the slug's project on `/mcp/<slug>`, the router's project after `project.use` or roots discovery, and otherwise the default project — **no newly registered session SHALL carry a null `project_id`**.

**Existing rows with a null `project_id` SHALL be repointed to the default project by the migration that retires the global scope.** Leaving them would keep the retired scope alive in a second table after the change claims to have removed it, and the operator surface would keep rendering a scope label for rows whose scope no longer exists. The count of such rows on a real installation is every path-less session ever registered.

The column SHALL remain nullable in this release. Flipping nullability on SQLite requires a full table rebuild, and the same rollback argument that keeps `memory.scope` present applies to it: a previous image booting against the migrated file must still find the schema it expects. Making it `NOT NULL` is deferred to the change that performs the other table rebuilds.

#### Scenario: A token is revoked while one of its sessions is active

- **WHEN** a token is revoked and a session bound to it is still `status = 'active'`
- **THEN** subsequent tool calls reusing that session id SHALL be rejected with `token_revoked` (existing auth behavior) and the session row SHALL be transitioned to `status = 'abandoned'` on the next request

#### Scenario: A session is started without a project but the token is project-scoped

- **WHEN** `memory.session_start` is called on `/mcp` with a token whose scope is `project:<id>` and the connection resolved to the default project
- **THEN** the call SHALL be rejected with code `forbidden` and SHALL NOT insert a session row
- **AND** the refusal SHALL name the pinned project and `project.use`

#### Scenario: A path-less session start binds to the default project

- **GIVEN** a path-less `/mcp` connection with a token authorized to write the default project, no prior `project.use` and no roots discovery
- **WHEN** `memory.session_start` is called
- **THEN** the session row SHALL carry the default project's `project_id` and SHALL NOT carry a null `project_id`

#### Scenario: Pre-existing scopeless sessions are repointed

- **GIVEN** a populated database holding sessions with `project_id IS NULL`
- **WHEN** the migration retiring the global scope is applied
- **THEN** every such row SHALL carry the default project's `project_id`, the total `sessions` row count SHALL be unchanged, and `SELECT count(*) FROM sessions WHERE project_id IS NULL` SHALL be `0`

### Requirement: Memories MAY anchor to a session of origin

The `memory` table SHALL gain a nullable `session_id` column referencing `sessions.id`. The `confirmations` table SHALL gain the same nullable column.

#### Scenario: An agent saves a memory after `memory.session_start`

- **WHEN** the active MCP transport session has a registered Rembric session for `(token, project)` and `memory.save` is called without an explicit `session_id` argument
- **THEN** the inserted row's `session_id` SHALL be set to the active Rembric session id

#### Scenario: An agent saves a memory without calling `memory.session_start`

- **WHEN** `memory.save` is called and no Rembric session is active for `(token, project, mcp-session-id)`
- **THEN** the inserted row's `session_id` SHALL be null and the call SHALL succeed (backwards compatibility)

#### Scenario: A pre-existing memory row predates this change

- **WHEN** the migration that adds `memory.session_id` runs against an existing data file
- **THEN** existing rows SHALL retain `session_id = NULL` and SHALL remain queryable through every existing tool unchanged

### Requirement: A session summary MUST follow the documented structure

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted in the session row's `summary` column, composed with what is already stored as "A curated session-summary write MUST be merged section-wise with the stored summary" requires. The server SHALL NOT enforce the layout — agents may submit free-form text — but the canonical structure SHALL be documented, and it SHALL be documented from ONE definition. The single exception to unenforced layout is the matching rule in "A curated session-summary write carrying no `##` heading MUST be refused against a sectioned stored summary", which never names a canonical heading and never fires on a session whose stored summary carries none.

The canonical structure SHALL consist of exactly these Markdown level-2 headings, in this order, each on its own line: `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`. The instruction SHALL explicitly say that they are exact level-2 headings on separate lines and SHALL NOT present bare section names as one dot-separated paragraph. The headings carry: the goal the session was pursuing; the work actually accomplished; the decisions taken and the reason for each; what was verified and by what means; what was left unfinished or blocked, and why; and the files that matter. A structure that names only outcomes produces a summary a later reader cannot act on: the reason a decision was taken and the evidence a claim rests on are the parts that do not survive in the code.

The canonical structure SHALL have a single source of truth in the server, exported as a named constant, and every surface that states it to a model SHALL derive or fixture-pin its text from that definition rather than invent a client-specific list. A test SHALL enumerate those surfaces and SHALL fail when one carries text the constant does not, omits or reorders a heading, appends a heading, or restores the flat dot-separated form. This requirement exists because agreement on section names is insufficient when all agreeing surfaces teach Markdown that renders as one paragraph.

Every model-facing surface, including the `memory.session_summary` tool description, SHALL carry the exact heading directive. Longer reasons/evidence guidance MAY remain concentrated in the end-of-turn rubric, but the bounded tool description has sufficient room for the six headings and separate-line instruction within the host truncation ceiling documented in `mcp-api`.

**The summary a model is asked for is the session's CURRENT COMPLETE state, not the delta since its last write, and the write REFINES that state rather than substituting for it.** A curated write composes with what is stored, section by section, so the stored summary is the accumulated state and each write brings part of it up to date. Every model-facing surface SHALL ask for the state that currently holds for the whole session, concise rather than exhaustive, and SHALL NOT ask for a summary whose CONTENT is "what changed since last time", "what this window did", or anything else shaped as a report of the latest turn. A model that cannot see its earlier work SHALL be directed to read the stored summary first (`memory.session_get`) rather than to write what it can see.

**Sending fewer SECTIONS is not delta framing, and the two SHALL NOT be conflated.** A curated write MAY carry only the sections that changed — that is the intended use of the merge — provided each section it carries states that section's full current state. What is prohibited is a section body that is itself a fragment, and a document that reads as a turn report. The surfaces enumerated in `mcp-api` SHALL state both halves: that an omitted `##` section keeps its stored text, and that a section which has genuinely emptied is written with an explicit short value rather than dropped, so a shrinking summary is condensation and never deletion.

**The server retains no copy of text a curated write replaces, and this is a deliberate, accepted consequence.** Preservation is by OMISSION and by omission only: a `##` section the write does not carry survives byte-identically, and a write carrying no `##` heading at all against a sectioned stored summary is refused. What a write DOES carry replaces the matching section outright, and the replaced bytes are gone — there is no version table, no journal payload, no restore verb, and no read that can return them. Condensing a section is legitimate and is what the surfaces above ask for at a 10 000-character cap; substituting a thin line for a dense section is loss, and the server SHALL NOT attempt to distinguish the two, because a correct summary legitimately shrinks and every guard proposed on that basis has been rejected on that ground. The obligation this places on the model-facing surfaces is the "condense, never delete" text they already carry; the obligation it places on this specification is to say plainly that the loss is unrecoverable rather than imply a safety net that does not exist.

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

- **GIVEN** session `<S>` is `active` with summary "A" written via a prior `memory.session_summary` (final:true), where "A" carries no `##` heading
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes)
- **AND** the response SHALL succeed
- **AND** the displaced "A" SHALL NOT be readable from any server surface afterwards — no version row, no journal payload, no restore verb; a document with no `##` heading cannot express preservation by omission, so whole replacement is the whole outcome
- **AND** where "A" and "B" both carry `##` headings the same last-final-wins rule SHALL apply PER SECTION rather than to the document (see "A curated session-summary write MUST be merged section-wise with the stored summary"), so only the sections "B" actually carries lose their previous text

#### Scenario: No model-facing surface asks for a turn report

- **WHEN** every surface enumerated by the canonical-structure test is inspected
- **THEN** none SHALL instruct the model to send a summary whose content is only what is new, only what changed, or only what the current context window contains
- **AND** the `memory.session_summary` description and the `initialize.instructions` block SHALL state that a `##` section the write omits keeps its stored text
- **AND** no surface SHALL be required by this scenario to state the merge rule beyond those two — the surfaces that ask for the session's current complete state remain correct under the merge, because a complete document replaces every section

#### Scenario: No surface promises recovery of replaced text

- **WHEN** every model-facing and operator-facing surface that describes the curated write is inspected — the `memory.session_summary` description, the `memory.session_get` description, the `initialize.instructions` block, and the dashboard session detail view
- **THEN** none SHALL state or imply that text replaced by a curated write can be read back afterwards
- **AND** none SHALL name a version, a history, or a restore

#### Scenario: The current-first ordering is stated where the model reads about the tool

- **WHEN** the `memory.session_summary` tool description and the `initialize.instructions` block are inspected
- **THEN** each SHALL state that the current state goes first
- **AND** neither SHALL be over its published length ceiling as a result (`mcp-api`)

#### Scenario: The documented structure uses exact Markdown headings on separate lines

- **WHEN** any model-facing session-summary structure is inspected
- **THEN** it SHALL name exactly `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files` in that order
- **AND** it SHALL direct the model to put each heading on its own line rather than emit `Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files` as one paragraph

#### Scenario: Free-form summary storage remains accepted

- **GIVEN** the session's stored summary is absent, uncurated, or itself free of `##` headings
- **WHEN** an otherwise-valid `memory.session_summary` call submits non-empty free-form text without the canonical headings
- **THEN** the server SHALL persist it under the ordinary precedence, merge and cap rules rather than reject it for layout
- **AND** the rejection in "A curated session-summary write carrying no `##` heading MUST be refused against a sectioned stored summary" SHALL NOT fire, because it is conditioned on the STORED value carrying a heading rather than on the write's layout

### Requirement: `memory.session_start` MAY accept an explicit project slug

The `memory.session_start` tool SHALL accept an optional `project?: string` argument (a slug, not a path). When provided, it SHALL override any auto-detected scope from `roots/list` but SHALL respect the connection-level scope from a path-scoped URL (`/mcp/<slug>`). The slug resolution rules of the `projects` capability apply: unknown slugs reject with `project_not_found` (with `suggestedSlugs[]`), and creation requires the agent to use `project.use({slug, autocreate: true})` separately first.

#### Scenario: `memory.session_start` with an explicit valid slug on `/mcp`

- **WHEN** the agent calls `memory.session_start({agent: 'claude-code', project: 'rembric'})` on a `/mcp` (no path slug) connection and the slug exists
- **THEN** the inserted session row SHALL have `project_id` set to that project, regardless of any `roots`-derived suggestion

#### Scenario: `memory.session_start` with an explicit slug on `/mcp/<slug>` mismatching the path

- **WHEN** the agent calls `memory.session_start({project: 'api'})` on a connection at `/mcp/rembric`
- **THEN** the call SHALL be rejected with code `scope_locked` and a message clarifying that the connection is path-scoped to `'rembric'`

#### Scenario: `memory.session_start` with an unknown slug

- **WHEN** the agent calls `memory.session_start({project: 'unknown-slug'})` and the slug does not exist
- **THEN** the call SHALL be rejected with code `project_not_found` and `suggestedSlugs[]` in the payload; no session row SHALL be inserted

### Requirement: A project switch MUST NOT happen while a session is active

When a session is `status = 'active'` for the current MCP transport, the `project.use` tool SHALL refuse to switch the active project — even with `confirmSwitch: true` — until the session is closed via `memory.session_end` or `memory.session_summary`.

#### Scenario: `project.use` switch attempted with active session

- **WHEN** the agent calls `project.use({slug: 'api', confirmSwitch: true})` while a session is active in project `'rembric'`
- **THEN** the call SHALL be rejected with code `session_active_must_end` and a payload `{ activeSessionId, currentSlug, targetSlug }`

#### Scenario: Closing a session then switching

- **GIVEN** an active session in project `'rembric'`
- **WHEN** the agent calls `memory.session_summary({summary})` and then `project.use({slug: 'api', confirmSwitch: true})`
- **THEN** the second call SHALL succeed with `switched: true` and `previousSlug: 'rembric'`

### Requirement: Server restart MUST mark in-flight sessions as abandoned

In-process session routing state (`mcp-session-id` → active Rembric session id) is not persisted, so a restart loses every route into a live session and the rows it pointed at can never be closed by their own client.

Stale-active retirement SHALL therefore run at startup **and** periodically thereafter (see "Session rows MUST record last activity, and stale-active retirement MUST be periodic"), and BOTH passes SHALL use the same single retirement query so they cannot diverge. That query SHALL key on `COALESCE(last_activity_at, started_at)` — not on `started_at` alone: a genuinely long-running session that is still being written to would otherwise be retired out from under its client at the 24-hour mark, and a row predating the `last_activity_at` column would otherwise never be retired at all. Rows whose effective last activity is older than the configured `SESSION_ABANDON_AFTER_MS` (default `24h`) SHALL be transitioned to `status = 'abandoned'` with `ended_at = now`.

#### Scenario: Server restarts while a session is active

- **WHEN** the server process exits while a session has `status = 'active'` and the next startup reads an effective last activity older than 24 hours
- **THEN** the session SHALL be flipped to `status = 'abandoned'` and a row in the startup log SHALL record the transition

#### Scenario: Server restarts within the abandon window

- **WHEN** the server restarts and an `active` session's effective last activity is younger than 24h
- **THEN** the row SHALL be left `active`; the next tool call referencing it SHALL be accepted (the agent can `session_end` it explicitly or continue)

#### Scenario: A long-running session is not retired on its start time

- **GIVEN** an `active` session started 3 days ago whose `last_activity_at` is 10 minutes old
- **WHEN** either retirement pass runs
- **THEN** the row SHALL be left `active`

#### Scenario: A row predating the activity column is still retired

- **GIVEN** an `active` session with `last_activity_at IS NULL` and a `started_at` older than the abandon window
- **WHEN** either retirement pass runs
- **THEN** the row SHALL be flipped to `abandoned`

### Requirement: Sessions MAY be soft-deleted while preserving the audit trail

The `agent_sessions` table SHALL gain a nullable column `deleted_at TIMESTAMP`. A row with `deleted_at IS NOT NULL` is _soft-deleted_: it remains physically present, its `id` continues to satisfy every existing `memory.session_id` foreign-key reference, but it is hidden from default-visible listings.

`AgentSessionsService` SHALL expose:

- `softDelete(sessionId, {tokenId?, adminBypass?})`: sets `deleted_at` to `now()`. Calling this on an already-deleted row SHALL be a no-op that returns the existing row (idempotent). Without `adminBypass`, the caller's `tokenId` SHALL match the row's `token_id`; mismatches SHALL be rejected with `forbidden`.
- `undelete(sessionId, {adminBypass?})`: clears `deleted_at`. Only admin (operator-facing) callers may invoke this; agent-facing callers SHALL NOT have access.

`AgentSessionsService.list(...)` SHALL apply `WHERE deleted_at IS NULL` by default. `list(...)` SHALL accept an `includeDeleted: true` option to surface deleted rows. `AgentSessionsService.recentForContext(...)` SHALL apply BOTH `WHERE deleted_at IS NULL` AND the `sessionHasContent` predicate defined below; it SHALL NOT accept any option that bypasses either filter — memory-context callers SHALL never see deleted sessions and SHALL never see empty sessions.

`AgentSessionsService.findById(...)` SHALL NOT filter on `deleted_at` or on `sessionHasContent`. The detail surface must still be able to open and act on (e.g. undelete) any row regardless of content.

Every service write path that mutates a session's own columns SHALL refuse a soft-deleted row. Specifically `AgentSessionsService.end` and `AgentSessionsService.writeSummary` SHALL throw `DomainError('session_deleted', <message>)` when the row they resolved has `deleted_at IS NOT NULL`, on the `active` branch and the terminal branch alike, and SHALL evaluate that condition against the row read inside the same synchronous tick as the `UPDATE` — after the cross-token mask and before the `status` branch, so that exactly one evaluation covers both branches.

The placement is load-bearing, not stylistic. Both HTTP callers await the request body between their own soft-delete gate and the service call (`POST /api/<slug>/sessions/:id/summary` and `.../end`), and that body may carry up to `SUMMARY_MAX_CHARS`, so a check taken on an earlier tick can be invalidated before the write lands. A caller-side gate is therefore advisory — it exists to produce the operator-facing message early — and the service's own re-read is the evaluation that decides. A row soft-deleted after a caller's gate passed SHALL be rejected rather than mutated.

`softDelete` and `undelete` are exempt, being the paths by which `deleted_at` moves. The status-only reconciliation paths `abandonInactiveSince` and `markAbandoned` are also outside this requirement: they write `status` and `ended_at` only, and whether they should additionally skip soft-deleted rows is not decided here.

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

#### Scenario: `end()` refuses a soft-deleted active row

- **GIVEN** session `<S>` with `status='active'`, `ended_at IS NULL` and `deleted_at IS NOT NULL`
- **WHEN** `agentSessions.end(<S>, { tokenId: <owning token> })` is called
- **THEN** the call SHALL throw `DomainError('session_deleted', <message>)`
- **AND** the row SHALL NOT be mutated: `status` SHALL remain `'active'`, `ended_at` SHALL remain NULL, and `summary`/`title` SHALL be unchanged

#### Scenario: `writeSummary()` refuses a soft-deleted active row

- **GIVEN** session `<S>` with `status='active'` and `deleted_at IS NOT NULL`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: <owning token>, summary: 'anything' })` is called
- **THEN** the call SHALL throw `DomainError('session_deleted', <message>)`
- **AND** `summary`, `title` and `last_activity_at` SHALL all be unchanged

#### Scenario: The refusal is identical on a terminal row

- **GIVEN** session `<S>` with `deleted_at IS NOT NULL` and `status` of either `'ended'` or `'abandoned'`
- **WHEN** `agentSessions.end(<S>, …)` or `agentSessions.writeSummary(<S>, …)` is called by the owning token
- **THEN** the call SHALL throw `DomainError('session_deleted', <message>)` and SHALL NOT emit an `UPDATE`

#### Scenario: A soft-delete landing between a caller's gate and the write is still rejected

- **GIVEN** session `<S>` whose `deleted_at` is NULL at the moment a caller runs its own soft-delete gate
- **WHEN** `<S>` is soft-deleted before that caller reaches `end()` or `writeSummary()`, and the call then proceeds
- **THEN** the service SHALL reject with `session_deleted` on the strength of its own re-read
- **AND** the row SHALL NOT be mutated, whatever its `status` was

### Requirement: The dashboard MUST surface Delete + Undelete actions per session

The list view at `/dashboard/sessions` SHALL render an inline `<form action="/dashboard/sessions/<id>/delete" method="post">` per active row with a CSRF input and a `class="warn"` `Delete` button. The handler SHALL call `softDelete(id, {adminBypass: true})` and redirect to `/dashboard/sessions?deleted=<id>`. The list view SHALL render `?deleted=<id>` as a `flash success` containing an inline `Undelete` action.

The list view SHALL accept `?include_deleted=1` and render soft-deleted rows in a separate `<h2>Deleted</h2>` section beneath the Active table, mirroring how `/dashboard/projects` renders Archived projects.

The detail view at `/dashboard/sessions/:id` SHALL render whether the row is soft-deleted (regardless of the query parameter). When soft-deleted, the page SHALL display a `flash error` reading "This session is deleted." and the action area SHALL show an `Undelete` button (CSRF-protected) at `POST /dashboard/sessions/<id>/undelete` instead of `Delete`.

#### Scenario: Operator soft-deletes a session from the list view

- **GIVEN** an authenticated admin session and an active Rembric session row with id `<S>`
- **WHEN** the operator submits the row's Delete form
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions?deleted=<S>`
- **AND** the row SHALL NOT appear in a subsequent GET of `/dashboard/sessions`
- **AND** the row SHALL appear in a subsequent GET of `/dashboard/sessions?include_deleted=1`

#### Scenario: Operator undeletes from the detail view

- **GIVEN** a soft-deleted session at `/dashboard/sessions/<S>` and an authenticated admin
- **WHEN** the operator submits the Undelete form
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions`
- **AND** the row SHALL re-appear in the default list

#### Scenario: Delete without CSRF is rejected

- **GIVEN** an authenticated admin session
- **WHEN** a POST to `/dashboard/sessions/<S>/delete` arrives without the `csrf` field
- **THEN** the response SHALL be `403` with the standard `csrf_invalid` body

### Requirement: Session-tool handlers MUST honor the documented scope-resolution precedence

Every MCP tool handler under `apps/server/src/mcp/` that needs to resolve the effective project (`memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.save_prompt`, `memory.search_prompts`, `memory.session_end`, `memory.session_summary`, `memory.capture_passive`) SHALL resolve scope by consulting, in this order:

1. `ctx.project` from the request context, populated when the connection is path-scoped (`/mcp/<slug>`).
2. The `SessionRouter` entry for `(tokenId, mcpSessionId)`, populated by a prior `project.use` call or by roots-based discovery, when the connection is path-less (`ctx.requestedSlug === null`).
3. **The default project**, when neither source resolves one. There is no fourth step and no scopeless outcome.

A handler that resolves scope using only `ctx.project` and falls through directly to a scope of its own choosing SHALL be considered to be in violation of this requirement. In particular, a handler SHALL NOT construct the default project's scope itself — it SHALL obtain it from the shared resolver, so the resolution rule lives in one place and a change to it cannot leave a handler behind.

#### Scenario: Path-less connection with router pin returns project scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** an agent has called `project.use({slug: 'foo', autocreate: true})` successfully
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<foo.id>"` and the project's recent memories

#### Scenario: Path-less connection with no router entry returns global scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** no `project.use` call has been made on this MCP session
- **AND** no roots-based discovery has populated the router
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include the default project's scope and only that project's memories
- **AND** the scenario title predates this change: the fallback it names is the default project, not a global scope

#### Scenario: Path-scoped connection ignores router fallback

- **GIVEN** a token connected to `/mcp/bar` where project `bar` does not exist
- **AND** the router has a leftover entry pointing to project `foo` from a previous session reusing the same `(tokenId, mcpSessionId)` keys
- **WHEN** the agent calls `memory.context`
- **THEN** the call SHALL be refused with `code: 'project_not_found'` rather than resolving to any project, and SHALL NOT fall back to the default project
- **AND** the response SHALL NOT leak `foo`'s memories

#### Scenario: Path-scoped connection to existing project returns that project's scope

- **GIVEN** a token connected to `/mcp/baz` where project `baz` exists
- **AND** auth has resolved `ctx.project` to the `baz` project
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<baz.id>"` regardless of any router state

#### Scenario: `memory.search_prompts` honours router-based scope resolution

- **GIVEN** a token connected to `/mcp` (path-less) with a `project.use({slug: 'foo'})` pin
- **WHEN** the agent calls `memory.search_prompts({ query: "anything" })`
- **THEN** the server SHALL resolve scope to `project:<foo.id>` via the `SessionRouter` entry
- **AND** SHALL NOT return prompts from any other project, including the default project

### Requirement: Session rows MUST carry a title column with write-once-final precedence

The `sessions` table SHALL gain a nullable `title TEXT` column and two boolean precedence columns: `summary_final` and `title_final` (default `false`). The title SHALL be initialised at row creation with a placeholder of the form `basename(cwd) · HH:MM UTC` (or `session · HH:MM UTC` when `cwd` is unavailable), stored with `title_final = false`.

`AgentSessionsService.ensure(...)` (the HTTP-path constructor) SHALL compute and write the placeholder title atomically with the row insert. `AgentSessionsService.start(...)` (the MCP-path constructor) SHALL do the same.

Writes that update `summary` or `title` carrying `final:true` SHALL flip the corresponding `_final` column to `true`. A subsequent write carrying `final:false` SHALL be a no-op for the corresponding field. A subsequent write carrying `final:true` SHALL WIN the precedence contest for that field (last-final-wins for admin/manual edits in future scope). Winning precedence is not the same as replacing the column: for `title` the winning value is stored outright, while for `summary` the value stored is the section-wise merge of the stored summary and the write, so a `final:true` write that wins precedence does NOT necessarily replace the whole column — see "A curated session-summary write MUST be merged section-wise with the stored summary".

#### Scenario: Row insert writes placeholder title

- **WHEN** `ensure({id, cwd: '/Users/jane/projects/rembric', ...})` is called at 22:14 UTC and the row does not exist
- **THEN** the inserted row SHALL have `title = 'rembric · 22:14 UTC'` and `title_final = false`

#### Scenario: Final summary write blocks later non-final summary write

- **GIVEN** session `<S>` whose `summary` was written with `final:true` and `summary_final = true`
- **WHEN** another call attempts to write `summary` with `final:false`
- **THEN** the `summary` column SHALL remain unchanged
- **AND** `summary_final` SHALL remain `true`

#### Scenario: Non-final overwrite of placeholder title

- **GIVEN** session `<S>` with the placeholder title and `title_final = false`
- **WHEN** another call writes `title` with `final:false`
- **THEN** the `title` column SHALL be overwritten with the new value
- **AND** `title_final` SHALL remain `false`

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

### Requirement: The session purge journal is permanent

`consolidation_ops` rows written by `purgeEmpty` SHALL NOT themselves be subject to deletion. The journal preserves the audit trail of WHICH session ids existed and WHEN they were removed, even after the session rows are gone.

#### Scenario: A session purge journal row survives subsequent purges

- **GIVEN** `purgeEmpty` has run and produced a `consolidation_ops` row referencing 12 deleted session ids
- **WHEN** a subsequent `purgeEmpty` runs on a different set of session ids
- **THEN** the original `consolidation_ops` row SHALL still exist and its `affected_ids` SHALL still list the original 12 ids

### Requirement: `AgentSessionsService.markAbandoned()` MUST flip a single active session to abandoned with admin-bypass support

The service method `markAbandoned(sessionId: string, input?: { tokenId?: string; adminBypass?: boolean }): AgentSession` SHALL transition exactly one session row from `status = 'active'` to `status = 'abandoned'`, writing `ended_at = now()` in the same `UPDATE`. The transition rules are:

1. **Row lookup**. The service SHALL `SELECT` the row by `id`. If no row matches, it SHALL throw `DomainError('session_not_found', <message naming the id>)`.

2. **Token check**. When `input?.adminBypass` is not `true`, the service SHALL require `input?.tokenId` to equal the row's `token_id`. On mismatch (including `undefined` vs a row token id), the service SHALL throw `DomainError('forbidden', <message>)`. When `adminBypass: true`, the token check SHALL be skipped — mirroring the established pattern used by `softDelete` and `undelete`.

3. **Terminal-state handling**.
   - If the row's `status` is `'abandoned'`, the service SHALL return the existing row unchanged (idempotent no-op). It SHALL NOT mutate `ended_at`.
   - If the row's `status` is `'ended'`, the service SHALL throw `DomainError('session_already_ended', <message>)`. The reverse transition `ended → abandoned` SHALL NOT be allowed.

4. **Happy path**. When `status === 'active'`, the service SHALL emit an `UPDATE agent_sessions SET status='abandoned', ended_at = now() WHERE id = ?` and SHALL return the post-update row.

The method SHALL NOT mutate `agent`, `token_id`, `started_at`, `project_id`, `summary`, `title`, `summary_final`, `title_final`, or `deleted_at`. The only columns written are `status` and `ended_at`.

The method SHALL NOT call into `abandonStale` and `abandonStale` SHALL NOT call into `markAbandoned`; they are siblings serving distinct call sites (per-id operator surface vs. bulk reconciliation scheduler).

#### Scenario: markAbandoned flips an active session

- **GIVEN** a session with `id = <S>`, `status = 'active'`, `ended_at = NULL`, and `token_id = 't1'`
- **WHEN** `markAbandoned(<S>, { tokenId: 't1' })` is called
- **THEN** the row's `status` SHALL transition to `'abandoned'`
- **AND** `ended_at` SHALL be set to the current timestamp
- **AND** the returned value SHALL be the post-update row

#### Scenario: markAbandoned is idempotent on already-abandoned rows

- **GIVEN** a session with `status = 'abandoned'` and `ended_at = <T>`
- **WHEN** `markAbandoned` is called on it
- **THEN** the call SHALL succeed
- **AND** `ended_at` SHALL still equal `<T>` (no second write)
- **AND** the returned row SHALL be the existing one unchanged

#### Scenario: markAbandoned rejects ended sessions

- **GIVEN** a session with `status = 'ended'`
- **WHEN** `markAbandoned` is called on it
- **THEN** the service SHALL throw `DomainError('session_already_ended', ...)`
- **AND** the row SHALL NOT be mutated

#### Scenario: markAbandoned rejects cross-token without adminBypass

- **GIVEN** a session with `token_id = 't1'`
- **WHEN** `markAbandoned(<S>, { tokenId: 't2' })` is called
- **THEN** the service SHALL throw `DomainError('forbidden', ...)`
- **AND** the row SHALL NOT be mutated

#### Scenario: markAbandoned accepts cross-token with adminBypass

- **GIVEN** a session with `token_id = 't1'` and `status = 'active'`
- **WHEN** `markAbandoned(<S>, { adminBypass: true })` is called (no `tokenId` supplied)
- **THEN** the call SHALL succeed
- **AND** the row's `status` SHALL transition to `'abandoned'`

#### Scenario: markAbandoned throws on unknown id

- **WHEN** `markAbandoned('does-not-exist', { adminBypass: true })` is called
- **THEN** the service SHALL throw `DomainError('session_not_found', ...)`

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

### Requirement: `recentForContext` MUST exclude empty sessions by default

`AgentSessionsService.recentForContext({projectId, limit})` SHALL return at most `limit` rows, ordered by `started_at DESC`, drawn from the set of sessions satisfying ALL of:

1. `deleted_at IS NULL` (soft-delete already specified above);
2. scope match on `project_id = ?`, where `projectId` is always a resolved project id — the method SHALL NOT accept a null `projectId` as a request for a scopeless population, because no such population exists;
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

#### Scenario: The default project's sessions are returned like any other project's

- **GIVEN** the default project holding one useful session and project `A` holding another
- **WHEN** `recentForContext` is called with the default project's id
- **THEN** the result SHALL contain only the default project's session, and SHALL NOT contain project `A`'s

### Requirement: `memory.context` MUST display-truncate every text field to one shared bound

The `memory.context` handler (`handleContext` in `apps/server/src/mcp/memory-tools.ts`) SHALL NOT emit any stored long-form text verbatim. Every text field of its response SHALL be display-truncated through the same `snippet(content, max)` helper, using a single module-level bound `CONTEXT_SNIPPET_CHARS`, producing a value of at most `CONTEXT_SNIPPET_CHARS` characters with a trailing `…` ellipsis when truncation occurs. The fields covered are:

- `recentSessions[].summary`
- `recentPrompts[].content`
- `recentMemories[].snippet`
- `pendingJudgments[].sourceSnippet` and `pendingJudgments[].targetSnippet`

The four fields SHALL share the one constant; no per-field literal truncation length SHALL remain in `handleContext`.

This is a read-side display concern only. It SHALL NOT alter what is stored: the `sessions.summary` column, the `SUMMARY_MAX_CHARS` write cap, the `summary_final` precedence rule, prompt rows, and memory rows are all unaffected. The full values SHALL remain retrievable verbatim through every other surface (`memory.get`, the dashboard, and any read path that returns a row directly).

A `NULL` stored session summary SHALL be emitted as `null` (not coerced to an empty snippet). The default recent-session count SHALL remain `5` — this requirement governs per-field size, not item count.

`recentSessions[]` SHALL additionally include a `title` field, emitted **verbatim** as stored (`s.title`) — the curated title when the agent set one via `memory.session_summary`, otherwise the auto-generated placeholder. `title` is bounded to ≤100 chars at write time, so it is a short label emitted as-is and is NOT passed through the snippet helper. No filtering or hiding logic SHALL be applied: a populated title is emitted as-is, and a `null` stored title (should one ever occur) is emitted as `null`.

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

#### Scenario: A curated session title is surfaced verbatim

- **GIVEN** a session whose title was set via `memory.session_summary({ title })`
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].title` SHALL equal the stored title verbatim

#### Scenario: An uncurated session's title is still surfaced verbatim

- **GIVEN** a content-bearing session that was never summarized with a title (only the auto-generated placeholder exists)
- **WHEN** the agent calls `memory.context`
- **THEN** the corresponding `recentSessions[].title` SHALL equal the stored (placeholder) title verbatim — no hiding or nulling logic is applied

### Requirement: `memory.session_get` returns a session's full summary by id

The MCP surface SHALL expose a `memory.session_get` tool that returns a single session, identified by `sessionId`, including its **full, untruncated** `summary` (in contrast to `memory.context`, which returns a bounded snippet). The handler SHALL resolve scope using the documented session-tool scope-resolution precedence (`ctx.project` via path-scoping, then `SessionRouter`, via `resolveEffectiveProject` / `scopeFromContext`) and SHALL treat a session whose `project_id` does not match the resolved scope as `not_found`. A soft-deleted session (`deleted_at IS NOT NULL`) SHALL be returned as `not_found`. The tool SHALL be read-only and SHALL NOT mutate any row.

`memory.context` SHALL continue to return the bounded snippet for `recentSessions[].summary`; `memory.session_get` is the on-demand path for the full text (the multi-agent / cross-client handoff use case).

**The tool SHALL declare exactly one input property, `sessionId`.** It SHALL NOT declare a `limit` argument and SHALL NOT return a `versions` field. Both existed only to page the retired `session_summary_versions` table, and there is nothing left for either to bound or carry. Because tool input schemas are strict (`mcp-api`, "Every MCP tool input schema MUST refuse an unknown property rather than ignore it"), a caller that still sends `limit` SHALL be REFUSED with the transport's invalid-parameters error naming the tool and the property, never have it silently dropped. That refusal is the designed behaviour of strictness and SHALL NOT be exempted for this argument: a model carrying a stale description is told that it is stale, which a silent drop cannot do.

The full summary this tool returns is the ONLY session text the server holds, and the tool's description SHALL NOT imply the existence of any other. In particular it SHALL NOT offer, name, or hint at a recovery path for text a previous curated write displaced — after "A curated session-summary write MUST be merged section-wise with the stored summary" a section the write omits is not displaced at all, and a section the write carries is replaced with no copy retained anywhere.

#### Scenario: Returns the full summary for an in-scope session

- **GIVEN** a session `S` in the caller's scope with a stored `summary` longer than the `memory.context` snippet bound
- **WHEN** the agent calls `memory.session_get({ sessionId: S.id })`
- **THEN** the response SHALL include `S`'s full, untruncated `summary`

#### Scenario: A cross-scope session id is not found

- **GIVEN** a session `S` that belongs to a different project than the caller's resolved scope
- **WHEN** the agent calls `memory.session_get({ sessionId: S.id })`
- **THEN** the tool SHALL return a structured `not_found` error and SHALL NOT reveal `S`'s contents

#### Scenario: A soft-deleted session is not found

- **GIVEN** a session `S` in the caller's scope with `deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.session_get({ sessionId: S.id })`
- **THEN** the tool SHALL return a structured `not_found` error

#### Scenario: The response carries no `versions` field

- **GIVEN** any session `S` in the caller's scope, with or without a stored summary
- **WHEN** `memory.session_get({ sessionId: S.id })` is called
- **THEN** the response object SHALL NOT contain a `versions` key, in any form, including an empty array

#### Scenario: A stale caller sending `limit` is refused, not silently accepted

- **GIVEN** a connection whose model still carries the pre-retirement tool description
- **WHEN** it calls `memory.session_get({ sessionId: S.id, limit: 2 })`
- **THEN** the call SHALL be refused by input validation before the handler runs, with a message naming the tool and the property `limit`
- **AND** no session SHALL be returned and no row SHALL be read

#### Scenario: A call carrying only `sessionId` still succeeds

- **GIVEN** the same session `S`
- **WHEN** `memory.session_get({ sessionId: S.id })` is called
- **THEN** the call SHALL succeed and return `S`'s full summary — the control that makes the refusal above attributable to `limit` alone rather than to a broken tool

### Requirement: `findActiveForTransport` MUST NOT guess under concurrent ambiguity

`AgentSessionsService.findActiveForTransport({ tokenId, projectId })` (and the repository method behind it) is the fallback used to auto-attach an MCP write (`memory.save`, `memory.confirm`, `memory.session_summary`) or to decide session reuse (`memory.session_start`) when the caller supplied no explicit `sessionId` and no `SessionRouter` entry exists for the calling transport. It SHALL query for `status='active'` rows matching `(tokenId, projectId)` and:

1. Return that row when exactly one matches.
2. Return `null` when zero rows match.
3. Return `null` — never an arbitrary pick — when two or more rows match. Two or more concurrently active sessions under the same token+project is genuinely ambiguous; the method SHALL NOT use recency (`started_at`) or any other heuristic to break the tie, since doing so risks attaching to the wrong session, which is a worse outcome than no attachment.

Callers already handle a `null` result: `memory.save`/`memory.confirm` persist with `session_id = NULL`; `memory.session_start`'s reuse logic falls through to minting a fresh session rather than adopting an ambiguous one.

#### Scenario: Exactly one active session resolves normally

- **GIVEN** exactly one `active` session exists for `(tokenId, projectId)`
- **WHEN** `findActiveForTransport({ tokenId, projectId })` is called
- **THEN** it SHALL return that session

#### Scenario: No active session resolves to null

- **GIVEN** zero `active` sessions exist for `(tokenId, projectId)`
- **WHEN** `findActiveForTransport({ tokenId, projectId })` is called
- **THEN** it SHALL return `null`

#### Scenario: Two concurrently active sessions resolve to null, not the most recent

- **GIVEN** two `active` sessions exist for the same `(tokenId, projectId)`, one started before the other
- **WHEN** `findActiveForTransport({ tokenId, projectId })` is called
- **THEN** it SHALL return `null`
- **AND** neither session id SHALL be returned, regardless of which started more recently

#### Scenario: A memory.save with no explicit sessionId saves unattached under ambiguity

- **GIVEN** two `active` sessions exist for the caller's `(tokenId, projectId)` and no `SessionRouter` entry exists for the calling transport
- **WHEN** `memory.save` is called without an explicit `sessionId`
- **THEN** the saved row's `session_id` SHALL be `NULL`
- **AND** neither of the two candidate sessions SHALL be chosen

#### Scenario: memory.session_start mints a fresh session instead of reusing an ambiguous one

- **GIVEN** two `active` sessions already exist for the caller's `(tokenId, projectId)`
- **WHEN** `memory.session_start` is called with no explicit project-scoped session to resume
- **THEN** the server SHALL mint a new session row (the reuse-lookup finds no unambiguous candidate) rather than adopting either of the two existing ones

### Requirement: Session rows MUST record last activity, and stale-active retirement MUST be periodic

Transport-based session resolution refuses to guess when two or more `active` rows match a `(token_id, project_id)` — a deliberate rule that MUST be preserved. But nothing currently makes that ambiguity transient: stale-active retirement runs only at process boot and no activity signal exists on the row, so a single client killed without a lifecycle call (SIGKILL, OOM, a closed terminal) leaves an `active` row for the entire process lifetime. Every subsequent write that does not carry an explicit session id then persists with a null session id, for as long as the server runs.

Session rows SHALL carry a `last_activity_at` timestamp, updated by the session-lifecycle HTTP writes and by MCP writes that resolve to the session. Stale-active retirement SHALL run periodically — not only at boot — and SHALL key on `COALESCE(last_activity_at, started_at)`, the same single query the startup pass uses (see "Server restart MUST mark in-flight sessions as abandoned"); keying on `last_activity_at` alone would leave a row written before the column existed unretirable forever. Transport-based resolution SHALL exclude rows whose effective last activity is older than a short staleness window, so a zombie row stops creating ambiguity **without** introducing a recency tiebreak among genuinely-concurrent sessions.

#### Scenario: A killed client no longer blocks auto-attach

- **GIVEN** one `active` session row whose `last_activity_at` is older than the staleness window, and one freshly-active session row for the same `(token_id, project_id)`
- **WHEN** a write without an explicit session id resolves its session
- **THEN** the fresh row SHALL be selected and the stale row SHALL be ignored

#### Scenario: Two genuinely-concurrent sessions still refuse to guess

- **GIVEN** two `active` session rows for the same `(token_id, project_id)` whose `last_activity_at` are both inside the staleness window
- **WHEN** a write without an explicit session id resolves its session
- **THEN** resolution SHALL return no session rather than choosing by recency

#### Scenario: Stale rows are retired without a restart

- **GIVEN** an `active` session row whose `last_activity_at` predates the abandonment window
- **WHEN** the periodic retirement pass runs while the process continues to serve requests
- **THEN** the row SHALL be marked abandoned without requiring a process restart

### Requirement: Confirmations MUST record their originating session when one is resolvable

`confirmations.session_id` exists as an indexed column that no write path populates, so it is permanently null and its index is dead weight. Recording a confirmation SHALL attach the resolved session id when one is available — by the same resolution rules as other session-attaching writes, including an explicit override — so the affirmation channel carries the same provenance as the save channel.

#### Scenario: A confirmation made inside a resolvable session

- **GIVEN** an unambiguous active session for the caller's `(token_id, project_id)`
- **WHEN** `memory.confirm` records a confirmation
- **THEN** the inserted confirmation row SHALL carry that session's id

#### Scenario: A confirmation made with no resolvable session

- **WHEN** `memory.confirm` records a confirmation and no session is resolvable
- **THEN** the confirmation SHALL still be recorded, with a null session id

### Requirement: A session that ends without a curated summary MUST still leave grounded, checkable facts

When no curated summary was written, the fallback written on the agent's behalf SHALL consist of facts extracted deterministically from the session's own transcript, NOT a slice of that transcript.

The extraction SHALL emit only what is checkable without a model, and SHALL name at minimum: the files created, written or edited; the commands run, with the ones that failed identified as having failed; and the final exchange. It SHALL NOT include file diffs — the cap cannot hold them and version control already does.

Three properties are contracted. The output SHALL be traceable: every line SHALL correspond to an event in the transcript, so the fallback cannot assert something that did not happen. It SHALL be dense relative to prose, so that a fixed character budget carries more of a long session's substance. And it SHALL degrade gracefully under truncation: removing the beginning SHALL cost individual facts and SHALL NOT change the meaning of what remains.

Where a session's transcript cannot be parsed, the fallback SHALL degrade to the previous behaviour rather than fail, and SHALL NOT block or error the host.

**The extraction SHALL run on the session-close path, and SHALL NOT run per turn.** Its call site was previously the per-turn transcript sync, which `session-nudges` removes on the shell clients; the requirement is about the summary written when the agent never cooperated, which is a session-close event, so the call belongs there. Two consequences follow and are normative rather than incidental. First, the extraction is no longer on a per-turn synchronous path, where it measured ~0.5 s of `jq` per firing and 790 ms on an 8.36 MB transcript. Second, where a host allows the close event a budget tighter than every other event, the extraction SHALL be attempted inside that budget and SHALL fall through to the existing transcript formatter on any failure — an unparsed or over-budget extraction SHALL cost the facts, never the fallback.

#### Scenario: A session ends with edits and a failed command and no curated summary

- **GIVEN** a session in which two files were edited and one command exited non-zero, and `summary_final = false`
- **WHEN** the fallback is written on the agent's behalf
- **THEN** the persisted `summary` SHALL name both files and SHALL identify the failed command as having failed

#### Scenario: The fallback does not overwrite a curated summary

- **GIVEN** a session whose `summary_final = true`
- **WHEN** the fallback is written
- **THEN** the existing curated `summary` SHALL be unchanged, under the existing `final` precedence rules

#### Scenario: An unparseable transcript does not fail the host

- **GIVEN** a transcript the parser cannot read
- **WHEN** the fallback runs
- **THEN** it SHALL exit successfully, SHALL NOT block the host, and SHALL NOT write a malformed body

#### Scenario: The extraction runs once, at session close, not once per turn

- **WHEN** every call site of the fact extractor is enumerated at HEAD
- **THEN** it SHALL be reachable only from the session-close path
- **AND** no per-turn handler SHALL call it
- **AND** a host whose extractor is not implemented SHALL fall through to the transcript formatter, exactly as before this clause

### Requirement: Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary`

The `AgentSessionsService` SHALL expose a single canonical constant `SUMMARY_MAX_CHARS` and SHALL reject any `summary` argument whose `String.prototype.length` exceeds it. The cap SHALL be enforced **solely in the server** — there SHALL be no SQLite `CHECK` constraint that pins `summary` length to the cap value. The `CHECK (length(summary) <= 2000)` previously introduced in migration `0011` SHALL be removed by a table-rebuild migration. A database `CHECK` MAY remain only as a generous pathological-size guard (a value far above any plausible `SUMMARY_MAX_CHARS`, e.g. 1 MB) that does NOT track or pin the operative cap; changing `SUMMARY_MAX_CHARS` SHALL NOT require a database migration.

`SUMMARY_MAX_CHARS` SHALL be set high enough to carry a rich handoff summary (the design records the chosen value). The constant SHALL remain the single source of truth, exported and imported by the MCP zod schema (`apps/server/src/mcp/session-tools.ts`) and by the HTTP-layer truncation helper, so no layer can drift from the service-level cap. The server SHALL be the sole authoritative trimmer and the sole writer of the truncation marker. A client MAY bound its own wire payload above the server's cap — it cannot know a given server's cap at runtime, and a client hard-bounded to one version's value would silently under-deliver against a server whose cap is higher. What a client SHALL NOT do is trim the OPPOSITE side from the server: a payload selected as a tail and then re-cut as a head yields a middle window, which is neither. An invariant test SHALL assert that every client-side trim and the server's trim keep the same side.

Where the HTTP layer truncates an oversized body rather than rejecting it, it SHALL **retain the END of the text and discard the beginning**, and SHALL place the truncation marker at the FRONT of the result. Two reasons, and both are load-bearing:

- A session's conclusions, final state and unfinished items are at its end; its setup is at its beginning. Truncation that keeps the head discards exactly what a handoff exists to carry.
- A leading marker is what lets a reader distinguish a complete summary from the tail of a long one. A trailing marker cannot serve that purpose on a head-truncated body, because the text a reader sees begins at a real beginning and gives no signal that anything is missing.

Truncation MAY therefore happen more than once for a given payload, and that is safe precisely because the sides agree: two successive tail-cuts are idempotent in their result — the last `min(bounds)` characters of the original — whereas a tail-cut followed by a head-cut is not. A client that bounds its own payload SHALL prefer cutting at a record boundary over cutting mid-record, so the persisted artefact remains parseable.

The cap precondition SHALL be enforced before the `summary_final` precedence rule is evaluated, and before the row's `status` is consulted, by every write path that mutates `sessions.summary`, of which there are exactly two:

- `writeSummary({ summary, ... })`
- `end({ summary, ... })`

The enumeration is exhaustive and normative: `writeSummary` and `end` SHALL be the only service methods that write `sessions.summary`. Any further method that writes that column SHALL apply this same precondition in the same position and SHALL be enumerated here; a write path absent from this list is a defect in the list or in the path, never a licensed exception to the cap.

When `summary.length > SUMMARY_MAX_CHARS`, the service SHALL throw `DomainError('invalid_input', message)` where `message` SHALL contain the decimal string of `SUMMARY_MAX_CHARS` so callers (including the MCP tool envelope and HTTP handler) can surface the cap to the client without re-encoding it. The row SHALL NOT be mutated and `summary_final` SHALL NOT be lifted by a rejected call. This SHALL hold identically for `active` and terminal rows.

**A SECOND cap check SHALL be applied to the merged document, because the stored value is no longer the argument.** Since "A curated session-summary write MUST be merged section-wise with the stored summary", the value written to the column is a function of two inputs, and a check on the argument alone no longer bounds what is stored — the failure mode was measured before this rule existed: a composing write stored 10 350 characters against a 10 000-character cap and returned `ok: true`. The service SHALL therefore evaluate `SUMMARY_MAX_CHARS` a second time, against the merged value, immediately before that value enters the update `set` and inside the same single precedence site where the merge is computed. Both checks SHALL read the SAME constant; `SUMMARY_MAX_CHARS` remains the single source of truth and no second bound SHALL be introduced.

The argument check SHALL keep its published position — before the `summary_final` precedence rule and before `status` is consulted — so a pathological argument is still rejected before the row is read, and so a write whose value precedence discards never pays for a merge.

**An over-cap merge SHALL be REFUSED, never truncated.** The service SHALL throw `DomainError('invalid_input', message)` whose `message` states the merged length, contains the decimal string of `SUMMARY_MAX_CHARS`, and directs the caller to condense the summary and resend — naming `memory.session_get` as the way to read what is stored. The row SHALL NOT be mutated. Truncation SHALL NOT be applied to a merged document under any circumstance: the server's truncation helper keeps the TAIL and prefixes a marker, which on a sectioned summary discards `## Goal` first, and silent loss is the failure this rule set exists to remove.

The rejection SHALL NOT be able to wedge a session. A curated write that carries every heading present in the stored summary replaces the whole document, so a condensed full rewrite is always accepted regardless of how large the stored value was.

The HTTP layer's truncate-instead-of-reject behaviour is unchanged and applies to the incoming body only, before the service is called. A merged-overflow rejection reaches an HTTP caller as an error rather than a truncation; this is reachable only by a `final: true` HTTP write, which no shipped client performs.

#### Scenario: `writeSummary` rejects a summary of `SUMMARY_MAX_CHARS + 1`

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` whose message contains the decimal string of `SUMMARY_MAX_CHARS`
- **AND** the row in `sessions` SHALL remain unchanged (no summary written, `summary_final` unchanged)

#### Scenario: `writeSummary` rejects an oversized summary on a terminal row too

- **GIVEN** a session row owned by token `T` with `status='abandoned'`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` containing the cap value — the cap is checked before `status`, so admitting late writes SHALL NOT create an uncapped path
- **AND** the row SHALL remain unchanged

#### Scenario: `end` rejects an oversized summary atomically with the transition

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS + 1) })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` containing the cap value
- **AND** the row SHALL remain `status='active'`, `ended_at=NULL`, summary unchanged (the rejection precedes the transition)

#### Scenario: `writeSummary` accepts a summary of exactly `SUMMARY_MAX_CHARS`

- **GIVEN** an active session row owned by token `T`, `summary_final = false`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: 'a'.repeat(SUMMARY_MAX_CHARS), final: true })` is called
- **THEN** the call SHALL succeed and the row SHALL have `summary` of length `SUMMARY_MAX_CHARS` and `summary_final = true`

#### Scenario: A within-cap argument whose MERGE exceeds the cap is rejected

- **GIVEN** an `active` session row owned by token `T` with `summary_final = 1` and a stored sectioned summary of `SUMMARY_MAX_CHARS - 100` characters
- **WHEN** a curated write carries a NEW `##` section of 500 characters, so the argument is well within the cap but the merged document is `SUMMARY_MAX_CHARS + 400`
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` containing the decimal string of `SUMMARY_MAX_CHARS`, the merged length, and a direction to condense and resend
- **AND** the stored `summary` SHALL be byte-identical to what it was before the call
- **AND** nothing SHALL be truncated, on either the column or any other surface

#### Scenario: A condensed full rewrite always fits, so the rejection cannot wedge a session

- **GIVEN** a session whose stored curated summary is exactly `SUMMARY_MAX_CHARS` characters
- **WHEN** a curated write carries every heading present in the stored summary, with condensed bodies totalling well under the cap
- **THEN** the call SHALL succeed and the stored `summary` SHALL be exactly the condensed document

#### Scenario: A previously-stored 2000-char summary survives the CHECK-drop migration

- **GIVEN** a populated `sessions` table whose rows include summaries of length up to 2000 (the old cap)
- **WHEN** the table-rebuild migration that removes the `summary` `CHECK` runs
- **THEN** every existing row SHALL be preserved verbatim (the `INSERT … SELECT` copies all rows; relaxing the constraint rejects none)
- **AND** `PRAGMA foreign_key_check` SHALL report no violations before `COMMIT`

#### Scenario: Raising the cap requires no migration

- **GIVEN** the cap is enforced solely by `SUMMARY_MAX_CHARS` with no value-pinning DB `CHECK`
- **WHEN** an operator/maintainer changes `SUMMARY_MAX_CHARS` to a new value
- **THEN** the new cap SHALL take effect with no database migration or table rebuild

### Requirement: An empty or whitespace-only session summary MUST be rejected before the row is read

`AgentSessionsService.writeSummary` and `AgentSessionsService.end` SHALL reject a `summary` argument that is present but whose `String.prototype.trim()` yields the empty string, throwing `DomainError('invalid_input', message)` whose `message` names the rejecting method and states that the summary must be non-empty. Whitespace-only input SHALL be treated identically to `''`: a summary consisting solely of spaces, tabs or newlines carries no handoff and SHALL NOT be persisted.

This precondition SHALL be evaluated FIRST in both methods — before the `NUL`-byte check, before the `SUMMARY_MAX_CHARS` cap check, before the `title` length bound, and therefore before the row is read at all. Two consequences are normative, not incidental: a rejected call SHALL NOT read or mutate any row, and the error SHALL be `invalid_input` even when the `sessionId` names no existing session (the emptiness verdict precedes the `session_not_found` mask, the cross-token mask, the `session_deleted` check, the `status` branch and the `summary_final` precedence rule).

An ABSENT `summary` (`undefined`) SHALL NOT be rejected by this rule. `end({ tokenId })` with no summary is the ordinary close-without-summary path and SHALL succeed, leaving `summary` as it was; `writeSummary({ tokenId, title })` SHALL likewise be accepted as a title-only write.

This requirement states the SERVICE-level precondition. The tool-level rejections already specified for `memory.session_summary` (in this capability under "A session summary MUST follow the documented structure", and in `mcp-api`) are the same verdict observed from a caller; they are consistent with this rule and neither replaces it. The service check is the binding one, because it is the only one every write path passes through.

#### Scenario: `end` rejects a whitespace-only summary and leaves the session active

- **GIVEN** an active session row owned by token `T` with `summary IS NULL`
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T', summary: '   ' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` whose message states that the summary must be non-empty
- **AND** the row SHALL remain `status='active'` with `ended_at=NULL` and `summary IS NULL` — the rejection precedes the transition

#### Scenario: `writeSummary` rejects a whitespace-only summary

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: '\n\t ' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` whose message states that the summary must be non-empty
- **AND** `summary`, `title`, `summary_final` and `last_activity_at` SHALL all be unchanged

#### Scenario: The emptiness verdict precedes the row lookup

- **GIVEN** a `sessionId` that matches no row
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T', summary: '   ' })` or `agentSessions.writeSummary(sessionId, { tokenId: 'T', summary: '   ' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` and SHALL NOT throw `session_not_found`

#### Scenario: An absent summary is not an empty summary

- **GIVEN** an active session row owned by token `T`
- **WHEN** `agentSessions.end(sessionId, { tokenId: 'T' })` is called with no `summary` field
- **THEN** the call SHALL succeed, the row SHALL become `status='ended'` with `ended_at` set, and `summary` SHALL be unchanged

### Requirement: Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`

A session row whose `status` is `ended` or `abandoned` SHALL accept `summary` and `title` writes for the remainder of its life, with no time limit relative to `ended_at`. This SHALL hold for every write path that mutates those columns — `AgentSessionsService.writeSummary`, `AgentSessionsService.end`, and therefore `POST /api/<slug>/sessions/:id/summary`, `POST /api/<slug>/sessions/:id/end`, `memory.session_summary` and `memory.session_end` — so that no two of them disagree about the same row. (`memory.session_end` carries no summary/title arguments of its own, so on a terminal row it is a pure no-op rather than a write; it is listed because it must not reject either.)

Late writes SHALL be subject to the existing `summary_final` / `title_final` precedence rules with ONE deviation: on a terminal row an already-`final` column SHALL NOT be replaced, not even by a `final:true` write. On an `active` row last-final-wins is unchanged. The deviation exists because unbounded lateness makes the alternative lossy in a way sessions cannot recover from: a resumed host session reuses its id, its agent's obligatory `memory.session_summary` sends `final:true`, and sessions have no `replaces` chain or `consolidation_ops` journal, so the displaced handoff is gone with no audit trail. Before late writes were permitted the same call was rejected and the text survived; the first curated value therefore stands. A `final:false` write against an already-`final` column remains a silent no-op and is NOT an error.

The asymmetry is deliberate and interacts with `resume`: a row returned to `active` is governed by last-final-wins again, so the resumed conversation's curated handoff is no longer BLOCKED by the previous one. It does not replace it either. `resume` writes only `status`, `ended_at` and `last_activity_at`, so `summary_final` survives the revival and the resumed handoff meets an already-curated stored value — which makes it a curated-against-curated write, MERGED section-wise rather than substituted. Measured: a resumed row storing `## Goal\nShip X\n## Files\nsrc/a.ts`, written with `## Goal\nShip Y`, stores `## Goal\nShip Y\n## Files\nsrc/a.ts`. Both halves follow from rules stated elsewhere and need no separate rule here — the unblocking from the row no longer being terminal, the merge from "A curated session-summary write MUST be merged section-wise with the stored summary".

The cap precondition (`SUMMARY_MAX_CHARS`), the `NUL`-byte rejection, the `title` length bound and the cross-token mask (`session_not_found`) SHALL be evaluated in the service exactly as on an `active` row and BEFORE any column is written. The project-mismatch mask (`session_not_found`) SHALL be evaluated at the HTTP-handler and MCP-tool boundary. The soft-delete rejection (`session_deleted`) SHALL be evaluated at that boundary AND in the service, and the service's evaluation SHALL be the binding one: the boundary check runs before the request body is awaited and can therefore be stale by the time the write happens, so the service re-reads and decides. That service check is NOT specific to terminal rows — it sits ahead of the `status` branch and covers the `active` path identically; the full rule is stated once, under "Sessions MAY be soft-deleted while preserving the audit trail" in this capability. It exists because removing the `status !== 'active'` rejection also removed the backstop that incidentally protected a soft-deleted terminal row from a caller that forgot the gate, and because the gate a caller does remember is not fresh.

A late write SHALL NOT mutate `status`, `ended_at`, or `last_activity_at`. In particular `end()` on an `abandoned` row SHALL apply the summary/title writes and SHALL NOT flip `status` to `'ended'` and SHALL NOT write `ended_at`: the retirement sweep's classification of how the session died stands, and nothing about a summary write is a lifecycle event. `last_activity_at` is deliberately excluded because it exists solely to drive stale-active retirement and transport resolution, both of which filter `status = 'active'`.

Per-field precedence SHALL be folded into an update `set` in exactly ONE place, shared by all three write paths (the terminal write, `writeSummary`'s active path, `end`'s active path), so the three cannot drift. `resume` composes its own `set` and SHALL NOT call into that place, because it writes no precedence-governed column.

The status FSM SHALL be `active → ended | abandoned → active`, where the only edge back to `active` is the explicit `resume` verb specified in "`AgentSessionsService.resume()` MUST return a terminal session to `active`". `resume` SHALL be the ONLY path that writes `status: 'active'` outside the two row inserts, and the ONLY path that clears `ended_at`. No implicit path — `ensure`, `touchActivity`, `writeSummary`, `end`, `markAbandoned`, `abandonInactiveSince`, `softDelete`, `undelete` — SHALL move a row back to `active`, and none SHALL write `ended_at` on a row that already has one.

When a late write leaves every field unchanged (because precedence skipped all of them), the call SHALL return the existing row as a success and SHALL NOT emit an `UPDATE`.

#### Scenario: Late curated summary on an abandoned session

- **GIVEN** session `<S>` with `status='abandoned'`, `ended_at = E`, `last_activity_at = L`, `summary_final = false`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'Goal · Discoveries · …', title: 'Fix the reaper', final: true })` is called
- **THEN** the row SHALL have the new `summary` with `summary_final = true` and the new `title` with `title_final = true`
- **AND** `status` SHALL still be `'abandoned'`, `ended_at` SHALL still be `E`, and `last_activity_at` SHALL still be `L`
- **AND** the call SHALL return the updated row rather than throwing `session_already_ended`

#### Scenario: Late curated summary on an ended session

- **GIVEN** session `<S>` with `status='ended'`, `ended_at = E`, `last_activity_at = L`, `summary_final = false`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'late but curated', final: true })` is called
- **THEN** the row SHALL have `summary = 'late but curated'` and `summary_final = true`
- **AND** `status`, `ended_at` and `last_activity_at` SHALL be unchanged

#### Scenario: A per-turn raw transcript sync cannot clobber a curated summary on a terminal row

- **GIVEN** session `<S>` with `status='abandoned'` (or `'ended'`), `summary = 'curated'` and `summary_final = true`
- **WHEN** `writeSummary(<S>, { tokenId: 'T', summary: '<raw transcript>', final: false })` is called (the `Stop`-hook transcript sync)
- **THEN** the call SHALL succeed and the row's `summary` SHALL remain `'curated'` with `summary_final = true`
- **AND** no `UPDATE` SHALL be emitted for the row
- **AND** `status`, `ended_at` and `last_activity_at` SHALL be unchanged

#### Scenario: `end()` on an abandoned row writes the summary without changing the status

- **GIVEN** session `<S>` with `status='abandoned'` and `ended_at = E` set by the retirement sweep
- **WHEN** `agentSessions.end(<S>, { tokenId: 'T', summary: 'closing notes', final: true })` is called
- **THEN** the row SHALL have `summary = 'closing notes'` with `summary_final = true`
- **AND** `status` SHALL remain `'abandoned'` (NOT `'ended'`) and `ended_at` SHALL remain `E`
- **AND** the call SHALL NOT throw `session_already_ended`

#### Scenario: A late write is unbounded in time

- **GIVEN** session `<S>` with `status='abandoned'` whose `ended_at` is 30 days in the past
- **WHEN** a `summary` write arrives with `final:true`
- **THEN** it SHALL be applied — there SHALL be no lateness window, and no configuration value SHALL exist that can reject a write for being too late

#### Scenario: A late curated summary reaches the next session's context

- **GIVEN** session `<S>` with `status='abandoned'`, `deleted_at IS NULL`, and no curated summary
- **WHEN** a `summary` write lands with `final:true`, and a subsequent `memory.context` call resolves the same scope
- **THEN** `<S>` SHALL appear among the recent sessions, because the context-surfacing predicate keys on `summary IS NOT NULL AND summary_final = 1` and applies no `status` filter

#### Scenario: A late write on a soft-deleted terminal row is still rejected

- **GIVEN** session `<S>` with `status='abandoned'` and `deleted_at IS NOT NULL`
- **WHEN** a `summary` write arrives on any of the four request paths (`/summary`, `/end`, `memory.session_summary`, `memory.session_end`)
- **THEN** it SHALL be rejected with `session_deleted` and the row SHALL NOT be mutated

#### Scenario: A late write for a different token is still masked

- **GIVEN** session `<S>` with `status='abandoned'` owned by token `T1`
- **WHEN** token `T2` attempts a `summary` write on `<S>`
- **THEN** it SHALL be rejected with `session_not_found` (never `forbidden`, never `session_already_ended`) and the row SHALL NOT be mutated

#### Scenario: Only `resume` revives a terminal session

- **WHEN** a revival is added to any mutating verb of `AgentSessionsService` other than `resume` — the late summary/title write, `end`, `writeSummary`, `markAbandoned`, `abandonStale`, `touchActivity`, `softDelete`, `undelete`
- **THEN** a CI runtime test SHALL fail and the build SHALL be rejected
- **AND** the enforcement SHALL be that runtime test, which drives each of those verbs against a row in each terminal state and asserts `status` and `ended_at` are unmoved — NOT a grep over the source files, because a mutation test has already shown that a counting or text invariant over that surface passes while a revival is added inside a write path it does not read
- **AND** the test's coverage is bounded by its verb list, which is enumerated in the test rather than derived: a NEW mutating verb is not covered until it is added there, so adding one obliges extending the list in the same change

#### Scenario: `ended_at` cannot be rewritten by a late write

- **GIVEN** the paths that write `ended_at` to a timestamp (`end`'s active branch, `markAbandoned`, `abandonInactiveSince`) all match on `status = 'active'` in the `UPDATE` itself, while the one path that clears it (`resume`) issues an unguarded `UPDATE` (`requireActive: false`) behind an in-process early return on `status === 'active'` — sound because the connection is a single synchronous one, so the read and the write cannot interleave, and unsound to copy into any path that does not hold that property
- **WHEN** a late summary/title write lands on a row whose `ended_at` is already set
- **THEN** `ended_at` SHALL NOT appear in the update `set` and the stored value SHALL be unchanged
- **AND** a further update site able to write `ended_at` against a non-`active` row SHALL fail the CI test above

### Requirement: `AgentSessionsService.resume()` MUST return a terminal session to `active`

The service method `resume(sessionId: string, input: { tokenId: string }): AgentSession` SHALL be the sole path by which a session row re-enters `status = 'active'`. It SHALL evaluate, in this order:

1. **Row lookup.** `SELECT` the row by `id`. If no row matches, throw `DomainError('session_not_found', <message naming the id>)`.
2. **Cross-token mask.** If the row's `token_id` does not equal `input.tokenId`, throw `DomainError('session_not_found', …)` — never `forbidden`, matching the mask every other session verb applies, so a caller cannot probe for the existence of another token's session.
3. **Soft-delete gate.** If `deleted_at IS NOT NULL`, throw `DomainError('session_deleted', <message naming the deleted-at timestamp>)`. This check SHALL be taken against the row read in step 1, in the same synchronous tick as the write, for the reason stated under "Sessions MAY be soft-deleted while preserving the audit trail".
4. **Already-active no-op.** If `status` is already `'active'`, return the existing row unchanged and SHALL NOT emit an `UPDATE`. This is a success, not an error: a defensive caller must not be penalised for resuming a session that is already live.
5. **Revive.** Otherwise — `status IN ('ended','abandoned')` — emit exactly one `UPDATE` setting `status = 'active'`, `ended_at = NULL`, and `last_activity_at = now()`, and return the post-update row.

`resume` SHALL treat `ended` and `abandoned` identically. There SHALL be no branch, no differing error, and no configuration that admits one and refuses the other: `abandoned` is the documented steady state for the clients that never post `/end` and the outcome of stale-active retirement on every other client, so a resume that refused it would refuse the majority of the rows it exists to serve.

`resume` SHALL NOT write `agent`, `token_id`, `project_id`, `started_at`, `summary`, `summary_final`, `title`, `title_final` or `deleted_at`. The only columns written are `status`, `ended_at` and `last_activity_at`.

`last_activity_at` is REQUIRED, not incidental: `abandonInactiveSince` compares `COALESCE(last_activity_at, started_at)` against its cutoff, so a row revived without the stamp is already past the retirement window and would be re-abandoned by the next sweep pass.

`resume` SHALL NOT be reachable from `ensure`, `start`, `touchActivity`, `writeSummary` or `end`. It SHALL be reachable only from a caller that names the row's id explicitly: the `memory.session_resume` MCP tool (`mcp-api` capability) and the `POST /api/<slug>/sessions/:id/resume` route (`http-api` capability). Both carry the id in the request itself and neither infers it, so no idempotent per-turn path can revive a row as a side effect.

Nothing SHALL persist the fact that a resume occurred, the count of resumes, or the discarded `ended_at`. That history is deliberately not recorded in this capability; the values are reported once, in the resume response, and are not recoverable afterwards.

#### Scenario: Resuming an ended session

- **GIVEN** session `<S>` owned by token `T` with `status='ended'`, `ended_at = E`, `deleted_at IS NULL`
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called at instant `N`
- **THEN** the row SHALL have `status='active'`, `ended_at IS NULL`, and `last_activity_at = N`
- **AND** `started_at`, `agent`, `token_id`, `project_id`, `summary`, `summary_final`, `title` and `title_final` SHALL be byte-identical to their values before the call

#### Scenario: Resuming an abandoned session behaves identically

- **GIVEN** session `<S>` owned by token `T` with `status='abandoned'`, `ended_at = E` written by the retirement sweep
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called at instant `N`
- **THEN** the row SHALL have `status='active'`, `ended_at IS NULL`, and `last_activity_at = N`
- **AND** the outcome SHALL be indistinguishable from the ended case above in every column

#### Scenario: A resumed row survives the next retirement sweep

- **GIVEN** session `<S>` was abandoned by `abandonStale` because its `last_activity_at` was older than the abandon window
- **WHEN** `resume(<S>, { tokenId: 'T' })` succeeds and `abandonStale({ olderThanMs })` runs immediately afterwards with the same window
- **THEN** `<S>` SHALL remain `status='active'` with `ended_at IS NULL`, because its `last_activity_at` was re-stamped by the resume

#### Scenario: A resumed row leaves the purgeable-empty set

- **GIVEN** session `<S>` with no memories, no prompts and no curated summary, `status='ended'` and `ended_at` older than the purge grace, so it is returned by the purgeable-empty query
- **WHEN** `resume(<S>, { tokenId: 'T' })` succeeds
- **THEN** `<S>` SHALL NOT be returned by the purgeable-empty query, because that query requires `status IN ('ended','abandoned')`
- **AND** no change to the purge query itself SHALL be required for this to hold

#### Scenario: Resume on an already-active row is a no-op success

- **GIVEN** session `<S>` with `status='active'` and `last_activity_at = L`
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called
- **THEN** the call SHALL return the existing row without error
- **AND** no `UPDATE` SHALL be emitted, so `last_activity_at` SHALL still be `L`

#### Scenario: Resume for a different token is masked

- **GIVEN** session `<S>` owned by token `T1` with `status='ended'`
- **WHEN** token `T2` calls `resume(<S>, { tokenId: 'T2' })`
- **THEN** it SHALL be rejected with `session_not_found` (never `forbidden`) and the row SHALL NOT be mutated

#### Scenario: Resume on a soft-deleted row is refused

- **GIVEN** session `<S>` with `status='abandoned'` and `deleted_at IS NOT NULL`
- **WHEN** `resume(<S>, { tokenId: 'T' })` is called
- **THEN** it SHALL be rejected with `session_deleted` naming the deleted-at timestamp
- **AND** `status`, `ended_at` and `last_activity_at` SHALL be unchanged

#### Scenario: An ended row can reach `abandoned` only through a real live span

- **GIVEN** session `<S>` with `status='ended'` and `ended_at = E`
- **WHEN** `markAbandoned(<S>, …)` is called directly
- **THEN** it SHALL still throw `session_already_ended` — `resume` SHALL NOT weaken that guard
- **AND** the two-call sequence `resume(<S>)` followed by `markAbandoned(<S>)` SHALL succeed, producing `status='abandoned'` with a fresh `ended_at`, because between the two calls the row was genuinely `active`

### Requirement: A resumed session keeps its original `started_at`, and recent-session ordering is unchanged

`resume` SHALL NOT write `started_at`. The column records when the logical conversation first began, which a resume does not change, and it is immutable under "Sessions MUST be append-only".

The consequence SHALL be accepted rather than worked around: `recentForContext` orders by `started_at DESC` and applies no `status` filter, so a resumed conversation appears in `memory.context` exactly once — with its stable id, its curated summary, and its current `status` — but it does NOT re-sort to the head of the list on resume. A long-running resumed conversation MAY therefore rank below a newer, shorter one. No requirement in this capability SHALL claim that a resumed session is ordered by recency of activity.

Search ranking SHALL remain independent of session lifecycle: no memory's rank SHALL change because the session it is attached to was resumed.

#### Scenario: A resumed session appears once in `memory.context`, not twice

- **GIVEN** session `<S>` with a curated summary, resumed after being `ended`
- **WHEN** `memory.context` resolves the same scope
- **THEN** `<S>` SHALL appear exactly once among `recentSessions`, carrying its original `id` and `startedAt`
- **AND** no second row SHALL exist for the same logical conversation

#### Scenario: A resumed session is not re-dated to the head of the context list

- **GIVEN** session `<A>` started at `T0` and resumed at `T2`, and session `<B>` started at `T1` where `T0 < T1 < T2`, both with curated summaries in the same scope
- **WHEN** `memory.context` resolves that scope
- **THEN** `<B>` SHALL be ordered ahead of `<A>`, because ordering keys on `started_at`
- **AND** `<A>`'s `startedAt` SHALL still be `T0`

### Requirement: A curated session-summary write MUST be merged section-wise with the stored summary

A curated write — an incoming `final: true` write carrying a `summary` — against a session whose stored summary is itself curated (`summary IS NOT NULL` AND `summary_final = 1`) SHALL NOT replace the stored value as a whole. The value stored SHALL be the section-wise MERGE of the stored summary and the write. The merge SHALL be computed at the single site that folds per-field `final` precedence into an update `set` — see "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`", which requires that place to be shared by all three write paths — and SHALL be attempted only for a value that precedence says will actually be stored, so a late write to a terminal row whose `summary_final` is already `1` remains the silent no-op it is today, rather than becoming a rejection.

**What a section is.** A section SHALL begin at a line that is exactly a level-2 ATX Markdown heading — two `#` characters followed by at least one space or tab and then non-empty text — and SHALL extend to the line before the next such line, or to the end of the document. A heading of level 3 or deeper SHALL be body text of the enclosing section, because `### Sub-decision` under `## Decisions+why` is part of that section and not a peer of it. A line inside a fenced code block (a triple-backtick or `~~~` fence, opened and closed per CommonMark) SHALL NOT be treated as a heading: summaries carry diffs and shell snippets, and a fenced `## ` line read as a heading would split a code block into two independently-mergeable halves. Text preceding the first heading SHALL be a section whose key is empty. Line breaks SHALL be recognised as `\n` or `\r\n`; the merged document SHALL reuse its source lines verbatim, with no reflow and no normalisation of blank lines.

**How sections match.** Two sections match when their heading text, trimmed and lower-cased, is equal — so `## files` updates the stored `## Files` instead of appending a near-duplicate the model would then have to maintain twice. The heading LINE written into the merged document SHALL be the one supplied by whichever side provided that section's body. Where one document carries the same key more than once, its occurrences SHALL be concatenated in document order at the position of the first; this never discards text, and it is observable only on a document that already departs from the canonical structure.

**The merge.** The merged document SHALL be, in order: every section key present in the stored summary, in STORED order, taking the write's body where the write carries that key and the stored body otherwise; followed by every section key the write carries and the stored summary does not, in the write's own order. The stored order is normative rather than a formatting preference: `memory.context` shows only the head of a stored summary, so ordering by the write would let a two-section partial update hoist those two sections above `## Goal` and change the preview a later session reads.

**Round-trip identity pins the join.** A section owns its heading line and every following line up to (not including) the next heading line, trailing blank lines included, and sections are re-joined with the line terminator that separated them in their source. Merging a document with ITSELF SHALL therefore yield that document byte-for-byte. This is the property that keeps a partial write from silently reformatting the sections it did not touch, and it is what makes "a merge that changes nothing stores the same bytes" hold rather than being approximately true.

**A section's body is always its full current state.** What a curated write MAY omit is a SECTION; what it SHALL NOT carry is a partial section. This is the whole distinction between the partial write this requirement licenses and the delta framing prohibited by "A session summary MUST follow the documented structure": a partial write sends fewer sections, never a fragment of one.

**Omission is the ONLY preservation mechanism, and there is no copy behind it.** A section the write carries is replaced outright and its previous bytes are not retained anywhere — see "A session summary MUST follow the documented structure", which states the accepted consequence. This is why the distinction between omitting a section and rewriting it thinly is normative rather than stylistic: the first costs nothing and the second is unrecoverable.

**Empty is not absent.** A section the write carries with an empty body SHALL be stored as that heading with an empty body. No input SHALL remove a heading from the merged document — there is no delete verb, because a delete verb reachable by omission is what this requirement exists to remove.

**Which writes do NOT merge.** A `final: false` write SHALL replace exactly as before this requirement: the per-turn raw transcript sync every client performs is not a curated handoff and SHALL NOT be composed with one. A curated write against a stored summary that is absent or not curated (`summary_final = 0`) SHALL likewise replace it whole: a raw transcript that happens to contain a `## ` line SHALL NOT become a section that later curated writes must maintain.

#### Scenario: A partial curated write updates one section and preserves the others

- **GIVEN** an `active` session `<S>` with `summary_final = 1` and `summary` equal to `"## Goal\nShip X\n## Files\nsrc/a.ts"`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: '## Files\nsrc/a.ts, src/b.ts', final: true })` is called
- **THEN** the stored `summary` SHALL be `"## Goal\nShip X\n## Files\nsrc/a.ts, src/b.ts"`
- **AND** the `## Goal` section SHALL be byte-identical to what was stored before the write

#### Scenario: A section the write carries is replaced outright, not appended to

- **GIVEN** session `<S>` storing `"## Goal\nShip X"` with `summary_final = 1`
- **WHEN** a curated write carries `"## Goal\nShip Y"`
- **THEN** the stored `summary` SHALL be `"## Goal\nShip Y"` and SHALL NOT contain `Ship X`
- **AND** `Ship X` SHALL NOT be readable from any other server surface afterwards

#### Scenario: A heading only the write carries is appended after the stored sections

- **GIVEN** session `<S>` storing `"## Goal\nShip X\n## Files\nsrc/a.ts"` with `summary_final = 1`
- **WHEN** a curated write carries `"## Risks\nflaky test"`
- **THEN** the stored `summary` SHALL be `"## Goal\nShip X\n## Files\nsrc/a.ts\n## Risks\nflaky test"`

#### Scenario: Shared headings keep the stored order even when the write reorders them

- **GIVEN** session `<S>` storing `"## Goal\nA\n## Files\nB"` with `summary_final = 1`
- **WHEN** a curated write carries `"## Files\nB2\n## Goal\nA2"`
- **THEN** the stored `summary` SHALL be `"## Goal\nA2\n## Files\nB2"` — both bodies updated, the stored order kept

#### Scenario: Heading matching ignores case and surrounding whitespace

- **GIVEN** session `<S>` storing `"## Files\nsrc/a.ts"` with `summary_final = 1`
- **WHEN** a curated write carries `"##   files  \nsrc/b.ts"`
- **THEN** the merged document SHALL contain exactly ONE files section, whose body is `src/b.ts`
- **AND** the document SHALL NOT contain two headings differing only in case or spacing

#### Scenario: A `##` line inside a fenced code block is not a section boundary

- **GIVEN** session `<S>` storing a curated summary whose `## Files` section contains a fenced code block containing the line `## Goal`
- **WHEN** a curated write carries a new `## Goal` section
- **THEN** the fenced line SHALL remain body text of the `## Files` section, unchanged
- **AND** the document SHALL carry exactly one `## Goal` section, outside any fence

#### Scenario: A section carried with an empty body is stored empty rather than removed

- **GIVEN** session `<S>` storing `"## Goal\nA\n## Unfinished+why\nblocked on Y"` with `summary_final = 1`
- **WHEN** a curated write carries `"## Unfinished+why\n"`
- **THEN** the stored `summary` SHALL still contain the `## Unfinished+why` heading
- **AND** its body SHALL be empty
- **AND** the `## Goal` section SHALL be unchanged

#### Scenario: A `final: false` per-turn sync never merges

- **GIVEN** session `<S>` storing a curated six-section summary with `summary_final = 1`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: '<raw transcript>', final: false })` is called
- **THEN** the stored `summary` SHALL be unchanged (blocked by the existing `summary_final` precedence rule)
- **AND** no merge SHALL have been computed

#### Scenario: The first curated write over a raw body replaces it whole

- **GIVEN** session `<S>` with `summary = '<raw transcript containing a ## line>'` and `summary_final = 0`
- **WHEN** a curated write carries `"## Goal\nShip X"`
- **THEN** the stored `summary` SHALL be exactly `"## Goal\nShip X"`
- **AND** no part of the raw transcript SHALL survive in the stored value

#### Scenario: A late curated write to a terminal row is still a silent no-op

- **GIVEN** session `<S>` with `status = 'ended'`, `summary_final = 1` and a stored sectioned summary
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'a flat paragraph', final: true })` is called
- **THEN** the call SHALL succeed and the row SHALL be returned unchanged, exactly as before this requirement
- **AND** it SHALL NOT be rejected with `invalid_input`, because precedence discards the incoming value before any merge is attempted

#### Scenario: A merge that changes nothing stores the same bytes

- **GIVEN** session `<S>` storing `"## Goal\nA\n## Files\nB"` with `summary_final = 1`
- **WHEN** a curated write carries `"## Files\nB"`
- **THEN** the stored `summary` SHALL be byte-identical to what it was before the write

#### Scenario: Merging a document with itself is the identity

- **GIVEN** any stored curated summary, including one with blank lines between sections, a preamble, `###` subheadings and a fenced code block
- **WHEN** a curated write carries that exact same document
- **THEN** the stored value SHALL be byte-identical to the input — no reflow, no blank line added or removed, no heading re-cased

### Requirement: A curated session-summary write carrying no `##` heading MUST be refused against a sectioned stored summary

When a curated write would merge under "A curated session-summary write MUST be merged section-wise with the stored summary", and the write's own body contains ZERO level-2 headings while the stored summary contains at least one, the call SHALL be rejected with `DomainError('invalid_input', message)`. The row SHALL NOT be mutated, `summary_final` SHALL NOT be lifted, and the `message` SHALL say that the write carries no `##` section and name the canonical structure the stored summary already uses.

This is the one input the matching rule cannot interpret: there is no key on which to compose, and storing the write would delete every stored section at once — the failure this whole requirement set exists to remove. Treating the body as a preamble-only merge is worse than rejecting it, because it would leave a fresh paragraph above sections the model no longer believes exist and nothing would ever say so.

The rule is a MATCHING rule, not a format validator. It never names `Goal`, never counts headings, and never fires on a session whose stored summary carries no heading — so "Free-form summary storage remains accepted" continues to hold for every first curated write. That it also closes the path by which a sectioned summary degrades back to one flat paragraph is a consequence, not the justification.

#### Scenario: A flat-paragraph curated write against a sectioned summary is rejected

- **GIVEN** an `active` session `<S>` storing `"## Goal\nA\n## Files\nB"` with `summary_final = 1`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'Fixed the CI formatting job.', final: true })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', <message>)` naming the missing `##` section
- **AND** `summary`, `summary_final`, `title` and `last_activity_at` SHALL be unchanged

#### Scenario: A flat-paragraph curated write against an unsectioned summary is accepted

- **GIVEN** an `active` session `<S>` storing `"Goal: A. Files: B."` with `summary_final = 1` (a free-form curated summary with no headings)
- **WHEN** a curated write carries `'Fixed the CI formatting job.'`
- **THEN** the call SHALL succeed and the stored `summary` SHALL be `'Fixed the CI formatting job.'`

#### Scenario: A first curated write on an empty session may be free-form

- **GIVEN** an `active` session `<S>` with `summary IS NULL`
- **WHEN** a curated write carries a non-empty body with no `##` heading
- **THEN** the call SHALL succeed and the body SHALL be stored verbatim

#### Scenario: One heading is enough

- **GIVEN** an `active` session `<S>` storing a curated six-section summary
- **WHEN** a curated write carries a single `## Accomplished` section and nothing else
- **THEN** the call SHALL succeed and merge, because the write carries at least one heading

### Requirement: Session rows MUST carry the four nudge-gate timestamps, three of them monotone and the turn anchor free to follow the clock

`sessions` SHALL carry `last_work_at`, `last_summary_at`, `last_nudge_at` and `last_turn_report_at`, all `timestamp_ms`, all NULLABLE, all defaulting to NULL. `session-nudges` owns which write sets each and what the gate reads from them; this requirement owns their presence, their nullability, WHICH of them are monotone, and the migrations that add them.

**NULL means "never", and it is a load-bearing value rather than a missing one.** Every row that predates the columns reads NULL on all four, and the gate is specified so that a NULL row behaves as a silent one until a client reports work. A NULL `last_turn_report_at` means "no turn has been reported yet", and the first report of a session therefore anchors on `started_at`. No backfill SHALL be performed, and the reason is now stronger than the one originally given: there is no column anywhere from which `last_summary_at` could be inferred. The candidate this requirement was written against, `session_summary_versions.created_at`, was already the wrong instant — a byte-identical curated re-write appended no row, so the newest version's timestamp was not the moment the column was last written — and the table itself is retired (`persistence`, "The `session_summary_versions` table MUST be dropped by a dedicated migration, with `0033` retained on disk"). What remains on the row is `started_at`, `ended_at` and `last_activity_at`, none of which is the moment a summary was written. A pre-existing row therefore reads NULL and the gate treats it as silent until a client reports work, exactly as the paragraph above specifies for NULL.

**Three of them SHALL move forward only** — `last_work_at`, `last_summary_at` and `last_nudge_at`. A write SHALL NOT set one of those three to a value earlier than the value already stored. **No path SHALL clear ANY of the four to NULL once it holds a timestamp**, including `resume`, which clears `ended_at` and SHALL leave them alone: a session that is resumed keeps the moment its summary was last written, because that is still when it was last written.

**`last_turn_report_at` SHALL be stamped with the current instant on every report, and SHALL NOT be clamped forward.** It is the one exception and the exception is load-bearing rather than an oversight. The other three are cumulative observations — the latest moment at which work happened, a summary was stored, a notice was sent — and for those "the highest value seen" IS the value. `last_turn_report_at` is not an observation but an ANCHOR: it marks where the turn now being reported began, and the report that reads it is the same report that replaces it. Clamping it forward would leave a host whose clock steps backwards with an anchor AHEAD of a curated summary written after the step, so `last_work_at` would land later than `last_summary_at`, the gate's condition (2) would hold, and the notice would fire on exactly the turn that had just complied — the defect this column was added to remove. Measured on this tree with the clamp in place: the report following a mid-turn `memory.session_summary` returns one notice line where it must return none. Correctness here comes from the column having exactly ONE writer, not from moving forward only. The asymmetry of the two failures is what settles it: a backwards step costs at most one over-suppressed notice, bounded by the floor, while the clamped reading costs a notice fired at a model that did what it was asked.

The migration SHALL be a plain `ALTER TABLE sessions ADD COLUMN` per column. No table rebuild is required — no `CHECK`, no `NOT NULL`, no foreign key is introduced — so the rebuild dance and its `DROP TABLE` foreign-key hazard do not apply, and `PRAGMA foreign_key_check` passes trivially before `COMMIT`.

These columns SHALL be exempt from the summary/title `final` precedence machinery. They are not model-authored values and there is no writer whose claim on them could lose to another's.

#### Scenario: A populated table migrates without rewriting a row

- **GIVEN** a `sessions` table carrying rows with curated summaries, terminal statuses and soft-deletes
- **WHEN** the migration runs
- **THEN** every existing row SHALL be preserved verbatim with the new columns NULL
- **AND** `PRAGMA foreign_key_check` SHALL report no violations before `COMMIT`
- **AND** no table rebuild SHALL have occurred

#### Scenario: Resume does not reset the timestamps

- **GIVEN** session `<S>` with `status = 'ended'` and all four timestamps set
- **WHEN** `resume(<S>, { tokenId })` succeeds
- **THEN** `ended_at` SHALL be NULL and `status` SHALL be `'active'`
- **AND** `last_work_at`, `last_summary_at`, `last_nudge_at` and `last_turn_report_at` SHALL be byte-identical to their pre-resume values

#### Scenario: A stale write cannot move a timestamp backwards

- **GIVEN** session `<S>` whose `last_work_at` is `T`
- **WHEN** a write attempts to set `last_work_at` to a value earlier than `T`
- **THEN** the stored value SHALL remain `T`

#### Scenario: The turn anchor follows a clock that steps backwards, and the other three do not

- **GIVEN** session `<S>` whose `last_turn_report_at` is `T`, with `last_work_at` and `last_nudge_at` set
- **WHEN** a turn report is handled at an instant `E` earlier than `T`, because the host clock stepped backwards between two reports
- **THEN** `last_turn_report_at` SHALL be `E`
- **AND** `last_work_at` SHALL NOT have moved backwards and `last_nudge_at` SHALL be unchanged

#### Scenario: A turn that refreshes the summary after a backwards clock step is still not reminded

- **GIVEN** session `<S>` past the floor whose `last_turn_report_at` was stamped after a backwards clock step, so it reads earlier than the highest value the column has ever held
- **WHEN** the session's next turn writes a curated summary mid-turn and then reports itself with `usedTools: true`
- **THEN** no notice SHALL be returned, because `last_work_at` anchors on that earlier report and lands before `last_summary_at`
- **AND** the control SHALL pass in the same run: the identical timeline with the curated write removed SHALL return a notice, so the silence above is suppression and not an unreachable gate

#### Scenario: A report lost to an interrupted turn suppresses more, never less

- **GIVEN** two identical session timelines that differ only in that one report is never issued, as happens on a Hermes turn the user interrupts
- **WHEN** both are driven through the same turns
- **THEN** the lost-report timeline's `last_work_at` SHALL never be later than the kept-report timeline's at the same turn
- **AND** the control SHALL pass in the same run: there SHALL be a turn on which the kept-report timeline returns a notice and the lost-report one returns none
