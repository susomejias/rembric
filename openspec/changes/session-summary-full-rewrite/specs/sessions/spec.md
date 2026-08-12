## ADDED Requirements

### Requirement: Every curated session-summary write MUST append a version row in the same transaction

The schema SHALL carry a dedicated table `session_summary_versions` whose rows are the successive stored values of one session's curated summary:

| column       | type                                                     |
| ------------ | -------------------------------------------------------- |
| `id`         | TEXT PRIMARY KEY (ULID, minted from the write's `now()`)  |
| `session_id` | TEXT NOT NULL REFERENCES `sessions(id)` ON DELETE CASCADE |
| `version`    | INTEGER NOT NULL, UNIQUE together with `session_id`       |
| `content`    | TEXT NOT NULL                                            |
| `title`      | TEXT, nullable                                            |
| `created_at` | INTEGER NOT NULL (`timestamp_ms`)                        |

No further column SHALL be added by this requirement. `title` IS versioned alongside `content` (design D22, revising D6): the dashboard renders a version's `content` next to a title, and rendering the CURRENT `sessions.title` there is misleading whenever the title changed after that version was written — the pairing, not the label alone, is what a reader needs. The stored `title` SHALL be the value in effect on `sessions.title` immediately AFTER the same update that appends the row (the `updateById` result), never the write's own argument, because `title` is optional on every curated write and an argument-based store would write `NULL` on every write that only touched `summary`.

**The invariant.** For every session with at least one row in `session_summary_versions`, `sessions.summary` SHALL equal the `content` of that session's row with the greatest `version`, and that row's `title` SHALL equal `sessions.title` as it stood immediately after the write that appended it — both come from the one `updateById` result the append reads, so they cannot disagree at that instant. The column(s) and the version row SHALL be written inside ONE `db.transaction()`, so both land or neither does; a state in which the column advanced and the row did not SHALL NOT be reachable.

This is narrower than an ongoing equality for `title`: unlike `summary`, `title` MAY change through a write that does not append a version — a title-only `final: true` write reaching the active-session branch of `end()` with no `summary` argument, reachable only via `POST /:slug/sessions/:id/end` (the `memory.session_summary` tool's schema requires `summary` on every call, so this path does not exist through MCP). Such a write leaves `sessions.title` ahead of the newest version's `title` until the next content-changing curated write appends a fresh row pairing both current values. This is documented rather than silently assumed away.

**When a row is appended.** A version row SHALL be appended by exactly those writes that store a summary value carrying `final: true` — that is, the writes that pass the `summary_final` precedence rule with an incoming `final: true`, on `writeSummary` and on `end` alike (the two write paths enumerated in "Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary`"). A write that stores nothing SHALL append nothing: this covers the terminal-row branch where an already-`final` column blocks the incoming value, and the `final: false` branch where precedence discards it.

**A `final: false` write SHALL NEVER append a version row.** The per-turn raw transcript sync every client performs is a `final: false` write, and its body is a transcript rather than a curated handoff. Versioning it would spend the table on material the summary exists to distil, at one row per turn.

**An identical re-write appends nothing.** When the value about to be stored is byte-identical to the `content` of the session's newest existing version row, no version row SHALL be appended. The column write proceeds unchanged (it stores the same bytes), so the invariant above still holds. This is what keeps the tool's published `idempotentHint: true` honest — see `mcp-api`, "Every MCP tool MUST advertise behavioral annotations", which admits a tool whose "repeated invocation is side-effect-free or last-call-wins": a retry of the same body remains exactly that.

**The version numbering.** `version` SHALL be one greater than the greatest `version` currently stored for that session, computed inside the same transaction as the insert, and SHALL start at 1 for a session's first curated write — including the case where nothing was stored before. A history whose first entry is the second curated value is unreadable: the version numbers would imply a predecessor no reader can find, and the dashboard would present the origin of the text as missing rather than as absent.

**The guarantee is scoped to curated text, and the scope is normative.** A raw, uncurated `summary` (`summary_final = 0`) that a first curated write replaces SHALL NOT be versioned. It was never a handoff, it is reproducible from the host transcript that produced it, and treating it as a version would put a transcript dump at `version = 1` of every session that ever synced one.

**One site.** The append SHALL be emitted from the same single place that folds per-field `final` precedence into an update `set` — see "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`", which requires that place to be shared by all three write paths. A second append site is a defect, because the three paths would then be able to disagree about whether a stored value was recorded.

**A bounded, scoped read exists for models, and it is exceptional.** `memory.session_get` MAY return recent version rows via an optional `limit` argument (see `mcp-api`). Omitted or `0` SHALL leave the response byte-identical to a call that carries no `limit` at all — no `versions` field, not an empty array — so no existing caller pays anything for this capability. A `limit` above 0 SHALL return that many of the session's newest version rows, newest first, each `content` in FULL and never truncated. The read SHALL be resolved against the caller's `Scope` by a dedicated repository method, never the dashboard's unscoped `admin*` read. The table SHALL still NOT be exposed through `memory.context` or any HTTP route; only this capped MCP read and the operator-facing dashboard section (see `dashboard`) reach it.

#### Scenario: A first curated write on a session with no stored summary

- **GIVEN** an `active` session `<S>` with `summary IS NULL` and `summary_final = 0`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'A', final: true })` is called
- **THEN** `sessions.summary` SHALL be `'A'` with `summary_final = 1`
- **AND** exactly one row SHALL exist in `session_summary_versions` for `<S>`, with `version = 1` and `content = 'A'`

#### Scenario: A second curated write replaces the column and appends the second version

- **GIVEN** session `<S>` with `summary = 'A'`, `summary_final = 1`, and one version row (`version = 1`, `content = 'A'`)
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'B', final: true })` is called
- **THEN** `sessions.summary` SHALL be `'B'` (the published last-final-wins outcome is unchanged)
- **AND** `session_summary_versions` for `<S>` SHALL hold two rows, `version = 1` with `content = 'A'` and `version = 2` with `content = 'B'`
- **AND** the displaced text `'A'` SHALL be readable from the table after the write

#### Scenario: A byte-identical curated re-write appends no row

- **GIVEN** session `<S>` whose newest version row has `content = 'B'` and whose `summary` is `'B'`
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'B', final: true })` is called again
- **THEN** the call SHALL succeed
- **AND** the version count for `<S>` SHALL be unchanged
- **AND** `sessions.summary` SHALL still equal the newest version's `content`

#### Scenario: A raw per-turn sync appends no row

- **GIVEN** an `active` session `<S>` with no curated summary
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: '<raw transcript>', final: false })` is called on three successive turns
- **THEN** `sessions.summary` SHALL carry the last raw body, exactly as before this requirement
- **AND** `session_summary_versions` SHALL hold zero rows for `<S>`

#### Scenario: A blocked terminal write appends no row

- **GIVEN** session `<S>` with `status = 'ended'`, `summary = 'curated'`, `summary_final = 1`, and one version row
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'later', final: true })` is called
- **THEN** the column SHALL remain `'curated'` (the terminal no-replace deviation is unchanged)
- **AND** the version count SHALL be unchanged — nothing was stored, so nothing is recorded

#### Scenario: The first curated write over a raw body versions only the curated text

- **GIVEN** session `<S>` with `summary = '<raw transcript>'` and `summary_final = 0`
- **WHEN** a curated write with `final: true` stores `'Goal: …'`
- **THEN** `session_summary_versions` SHALL hold exactly one row for `<S>`, `version = 1`, `content = 'Goal: …'`
- **AND** the raw body SHALL NOT appear in the table

#### Scenario: A rejected write leaves no version row

- **GIVEN** an `active` session `<S>` owned by token `T`
- **WHEN** a write is rejected for any of the reasons that already reject one (empty/whitespace summary, `NUL` byte, over `SUMMARY_MAX_CHARS`, cross-token mask, soft-deleted row)
- **THEN** neither `sessions.summary` nor `session_summary_versions` SHALL be mutated

#### Scenario: The stored value and the version row are the same string, capped once

- **GIVEN** a curated write whose `summary` is exactly `SUMMARY_MAX_CHARS` characters
- **WHEN** it is applied
- **THEN** `sessions.summary` and the appended version's `content` SHALL be the SAME string of that length
- **AND** exactly ONE cap check SHALL have been applied, on the argument, by the existing `SUMMARY_MAX_CHARS` precondition — no second cap SHALL be introduced anywhere on this path

#### Scenario: A version row stores the title in effect, not the write's own argument

- **GIVEN** session `<S>` with `summary = 'A'`, `title = 'Title A'`, one version row (`version = 1`, `content = 'A'`, `title = 'Title A'`)
- **WHEN** `agentSessions.writeSummary(<S>, { tokenId: 'T', summary: 'B', final: true })` is called with NO `title` argument
- **THEN** `sessions.title` SHALL remain `'Title A'`
- **AND** the newly appended `version = 2` row SHALL have `title = 'Title A'` — the title in effect after the write, not `undefined`/`NULL`

#### Scenario: A title-only write can leave the newest version's title behind the live column

- **GIVEN** session `<S>` with one version row (`version = 1`, `content = 'A'`, `title = 'Title A'`)
- **WHEN** `POST /:slug/sessions/:id/end` is called with `{ title: 'Title B', final: true }` and no `summary`
- **THEN** `sessions.title` SHALL become `'Title B'`
- **AND** no new version row SHALL be appended (no `summary` was stored)
- **AND** the newest existing version row's `title` SHALL remain `'Title A'` until a later content-changing curated write appends a fresh row

#### Scenario: `memory.session_get` omitted or zero `limit` is byte-identical to before this capability existed

- **GIVEN** a session `<S>` with two version rows
- **WHEN** `memory.session_get({ sessionId: <S> })` is called, and separately `memory.session_get({ sessionId: <S>, limit: 0 })`
- **THEN** both responses SHALL be identical to each other and SHALL contain no `versions` field

#### Scenario: `memory.session_get` with a positive `limit` returns recent versions, newest first, untruncated

- **GIVEN** a session `<S>` with three version rows, each with `content` longer than `CONTEXT_SNIPPET_CHARS`
- **WHEN** `memory.session_get({ sessionId: <S>, limit: 2 })` is called
- **THEN** the response SHALL carry a `versions` array of exactly 2 entries, ordered newest first
- **AND** each entry's `content` SHALL be the FULL stored value, not truncated to any snippet bound

#### Scenario: `memory.session_get`'s `limit` is rejected above its maximum, not clamped

- **WHEN** `memory.session_get({ sessionId: <S>, limit: SESSION_GET_VERSIONS_MAX + 1 })` is called
- **THEN** the call SHALL be rejected by input validation before the handler runs
- **AND** no partial or clamped result SHALL be returned

### Requirement: `session_summary_versions` rows MUST be append-only, and removable only with their session

A row in `session_summary_versions` SHALL never be `UPDATE`d and never `DELETE`d by application code. There is no edit verb, no restore verb, and no purge verb for a version row: its whole value is that it is a fact about what was stored at a moment, and a mutable version row records nothing.

The one licensed physical removal is the session's own: the FK SHALL be declared `ON DELETE CASCADE`, so the operator-only escape hatch in "Sessions MAY be physically purged when empty" removes a session's version rows with it, in the same transaction and through the same statement. Two consequences are normative:

- The purge path SHALL NOT gain a `DELETE` statement of its own. The cascade is the mechanism; the allow-listed `DELETE FROM sessions` in `db/repositories/agent-sessions-repository.ts` stays the only physical deletion of session-owned data.
- A purged session's version rows are NOT recoverable from the journal, and this requirement SHALL NOT claim otherwise. `consolidation_ops` records identifiers, not payloads, so the `session_purge` op names the session ids and nothing more.

The cascade is unreachable under today's predicate, and the reason is worth stating because it is what makes the cascade a safety net rather than a routine path: purge-eligibility requires the complete absence of summary text — "Sessions MAY be physically purged when empty" states clause 3 as _no summary text at all (curated or raw) was ever written_ — and a session with a version row has a non-NULL `summary` by the invariant above. A `NO ACTION` FK would instead abort the whole purge batch with `FOREIGN KEY constraint failed` if that ever ceased to hold, which converts an operator action into an unexplained failure.

The invariants suite SHALL forbid, outside migrations, `db.delete(sessionSummaryVersions)`, raw `DELETE FROM session_summary_versions`, and any `UPDATE` of `content`, `title`, `version` or `session_id` on that table — in the same static-grep family that already pins `memory`, `sessions`, `prompts` and `memory_relations`. The table SHALL be classified as a SOURCE table in the shared schema inventory: it is the sole record of something an agent supplied and is reproducible from nothing.

#### Scenario: A version row cannot be edited

- **WHEN** the invariants suite scans non-test source files for an `UPDATE` of `session_summary_versions.content`, `.title`, `.version` or `.session_id`, or for a `DELETE` against that table
- **THEN** the suite SHALL fail naming the offending file and line

#### Scenario: Purging a session removes its version rows

- **GIVEN** a purge-eligible session (no summary text, no `title_final`, no anchored rows, ended over the grace period ago) that — contrary to the predicate — also has version rows
- **WHEN** `purgeEmpty({ adminBypass: true })` runs
- **THEN** the session row SHALL be deleted, its version rows SHALL be deleted with it by the cascade, and the batch SHALL NOT fail
- **AND** `PRAGMA foreign_key_check` SHALL report no violations afterwards

#### Scenario: A session carrying a version row is not purge-eligible

- **GIVEN** a session with at least one version row
- **WHEN** the purge predicate is evaluated
- **THEN** the session SHALL NOT be counted or deleted, because its `summary` is non-NULL

#### Scenario: The table is classified in the schema inventory

- **WHEN** the source/derived partition is asserted over the migrated schema
- **THEN** `session_summary_versions` SHALL appear in `SOURCE_TABLES` and SHALL NOT appear in `DERIVED_TABLES`

## MODIFIED Requirements

### Requirement: A session summary MUST follow the documented structure

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted in the session row's `summary` column. The server SHALL NOT enforce the layout — agents may submit free-form text — but the canonical structure SHALL be documented, and it SHALL be documented from ONE definition.

The canonical structure SHALL name, at minimum: the goal the session was pursuing; the work actually accomplished; the decisions taken and the reason for each; what was verified and by what means; what was left unfinished or blocked, and why; and the files that matter. A structure that names only outcomes produces a summary a later reader cannot act on: the reason a decision was taken and the evidence a claim rests on are the parts that do not survive in the code.

The canonical structure SHALL have a single source of truth in the server, exported as a named constant, and every surface that states it to a model SHALL derive its text from that constant rather than restate it. A test SHALL enumerate those surfaces and SHALL fail when one of them carries text the constant does not. This requirement exists because the structure was previously restated in six places and five of them named five sections while the sixth named seven, with nothing detecting the divergence.

One surface is exempt from carrying the long form and SHALL carry a terse pointer to it instead: the `memory.session_summary` tool description, which is bounded by the host truncation ceiling documented in `mcp-api` and has no room for it. The long form SHALL instead be delivered at the moment the model can still act on it (see `plugin-session-protocol`).

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

### Requirement: `memory.session_get` returns a session's full summary by id

The MCP surface SHALL expose a `memory.session_get` tool that returns a single session, identified by `sessionId`, including its **full, untruncated** `summary` (in contrast to `memory.context`, which returns a bounded snippet). The handler SHALL resolve scope using the documented session-tool scope-resolution precedence (`ctx.project` via path-scoping, then `SessionRouter`, via `resolveEffectiveProject` / `scopeFromContext`) and SHALL treat a session whose `project_id` does not match the resolved scope as `not_found`. A soft-deleted session (`deleted_at IS NOT NULL`) SHALL be returned as `not_found`. The tool SHALL be read-only and SHALL NOT mutate any row.

`memory.context` SHALL continue to return the bounded snippet for `recentSessions[].summary`; `memory.session_get` is the on-demand path for the full text (the multi-agent / cross-client handoff use case).

**The tool SHALL additionally accept an optional `limit` argument**, `z.number().int().min(0).max(SESSION_GET_VERSIONS_MAX)` (`SESSION_GET_VERSIONS_MAX = 5`). Omitted or `0` SHALL leave the response identical to a call carrying no `limit`: no `versions` field is added, so every caller that predates this argument is unaffected. A `limit` from 1 to `SESSION_GET_VERSIONS_MAX` SHALL add a `versions` field: an array of that many of the session's newest `session_summary_versions` rows, ordered newest first, each carrying `version`, `title`, `content` (in FULL, never truncated) and `createdAt`. A `limit` above `SESSION_GET_VERSIONS_MAX` SHALL be rejected by input validation, never clamped.

The `limit` read SHALL be resolved against the connection's `Scope`, by a repository method dedicated to this scoped read (never the dashboard's unscoped `admin*` read that backs the "SUMMARY HISTORY" section — see `dashboard`, `data-access`). A `sessionId` that resolves out of scope or to a soft-deleted row SHALL return `not_found` exactly as it does today, before any version read is attempted.

This surface is EXCEPTIONAL, and the tool's description SHALL say so: it exists to recover detail a later rewrite displaced, not as a routine substitute for the current summary this tool already returns in full. The description SHALL also disambiguate what `limit` bounds — the number of stored summary VERSIONS returned, not the length of any summary — because `limit` alone, on a tool that returns one object rather than a list, invites the opposite reading.

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

#### Scenario: `memory.session_get` without `limit` is unaffected

- **WHEN** `memory.session_get({ sessionId: S.id })` is called on a session with version rows
- **THEN** the response SHALL be exactly as it was before this requirement — no `versions` field present

#### Scenario: `memory.session_get` with `limit` returns recent versions newest-first, untruncated

- **GIVEN** a session with three version rows, each with `content` longer than `CONTEXT_SNIPPET_CHARS`
- **WHEN** `memory.session_get({ sessionId: S.id, limit: 2 })` is called
- **THEN** `versions` SHALL contain exactly 2 entries in order `[newest, second-newest]`
- **AND** each entry's `content` SHALL be full length, not truncated

#### Scenario: `memory.session_get`'s `limit` respects scope

- **GIVEN** a session in project A with version rows
- **WHEN** a connection scoped to project B calls `memory.session_get({ sessionId: <A's session>, limit: 1 })`
- **THEN** the call SHALL return `not_found`, exactly as it does today without `limit`
