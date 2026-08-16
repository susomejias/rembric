## ADDED Requirements

### Requirement: A curated session-summary write MUST be merged section-wise with the stored summary

A curated write — an incoming `final: true` write carrying a `summary` — against a session whose stored summary is itself curated (`summary IS NOT NULL` AND `summary_final = 1`) SHALL NOT replace the stored value as a whole. The value stored SHALL be the section-wise MERGE of the stored summary and the write. The merge SHALL be computed at the single site that folds per-field `final` precedence into an update `set` (see "Every curated session-summary write MUST append a version row in the same transaction", **One site**), and SHALL be attempted only for a value that precedence says will actually be stored — so a late write to a terminal row whose `summary_final` is already `1` remains the silent no-op it is today, rather than becoming a rejection.

**What a section is.** A section SHALL begin at a line that is exactly a level-2 ATX Markdown heading — two `#` characters followed by at least one space or tab and then non-empty text — and SHALL extend to the line before the next such line, or to the end of the document. A heading of level 3 or deeper SHALL be body text of the enclosing section, because `### Sub-decision` under `## Decisions+why` is part of that section and not a peer of it. A line inside a fenced code block (a triple-backtick or `~~~` fence, opened and closed per CommonMark) SHALL NOT be treated as a heading: summaries carry diffs and shell snippets, and a fenced `## ` line read as a heading would split a code block into two independently-mergeable halves. Text preceding the first heading SHALL be a section whose key is empty. Line breaks SHALL be recognised as `\n` or `\r\n`; the merged document SHALL reuse its source lines verbatim, with no reflow and no normalisation of blank lines.

**How sections match.** Two sections match when their heading text, trimmed and lower-cased, is equal — so `## files` updates the stored `## Files` instead of appending a near-duplicate the model would then have to maintain twice. The heading LINE written into the merged document SHALL be the one supplied by whichever side provided that section's body. Where one document carries the same key more than once, its occurrences SHALL be concatenated in document order at the position of the first; this never discards text, and it is observable only on a document that already departs from the canonical structure.

**The merge.** The merged document SHALL be, in order: every section key present in the stored summary, in STORED order, taking the write's body where the write carries that key and the stored body otherwise; followed by every section key the write carries and the stored summary does not, in the write's own order. The stored order is normative rather than a formatting preference: `memory.context` shows only the head of a stored summary, so ordering by the write would let a two-section partial update hoist those two sections above `## Goal` and change the preview a later session reads.

**Round-trip identity pins the join.** A section owns its heading line and every following line up to (not including) the next heading line, trailing blank lines included, and sections are re-joined with the line terminator that separated them in their source. Merging a document with ITSELF SHALL therefore yield that document byte-for-byte. This is the property that keeps a partial write from silently reformatting the sections it did not touch, and it is what makes "a merge that changes nothing stores the same bytes" hold rather than being approximately true.

**A section's body is always its full current state.** What a curated write MAY omit is a SECTION; what it SHALL NOT carry is a partial section. This is the whole distinction between the partial write this requirement licenses and the delta framing prohibited by "A session summary MUST follow the documented structure": a partial write sends fewer sections, never a fragment of one.

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

## MODIFIED Requirements

### Requirement: A session summary MUST follow the documented structure

When `memory.session_summary` is called, the submitted `summary` SHALL be persisted in the session row's `summary` column, composed with what is already stored as "A curated session-summary write MUST be merged section-wise with the stored summary" requires. The server SHALL NOT enforce the layout — agents may submit free-form text — but the canonical structure SHALL be documented, and it SHALL be documented from ONE definition. The single exception to unenforced layout is the matching rule in "A curated session-summary write carrying no `##` heading MUST be refused against a sectioned stored summary", which never names a canonical heading and never fires on a session whose stored summary carries none.

The canonical structure SHALL consist of exactly these Markdown level-2 headings, in this order, each on its own line: `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`. The instruction SHALL explicitly say that they are exact level-2 headings on separate lines and SHALL NOT present bare section names as one dot-separated paragraph. The headings carry: the goal the session was pursuing; the work actually accomplished; the decisions taken and the reason for each; what was verified and by what means; what was left unfinished or blocked, and why; and the files that matter. A structure that names only outcomes produces a summary a later reader cannot act on: the reason a decision was taken and the evidence a claim rests on are the parts that do not survive in the code.

The canonical structure SHALL have a single source of truth in the server, exported as a named constant, and every surface that states it to a model SHALL derive or fixture-pin its text from that definition rather than invent a client-specific list. A test SHALL enumerate those surfaces and SHALL fail when one carries text the constant does not, omits or reorders a heading, appends a heading, or restores the flat dot-separated form. This requirement exists because agreement on section names is insufficient when all agreeing surfaces teach Markdown that renders as one paragraph.

Every model-facing surface, including the `memory.session_summary` tool description, SHALL carry the exact heading directive. Longer reasons/evidence guidance MAY remain concentrated in the end-of-turn rubric, but the bounded tool description has sufficient room for the six headings and separate-line instruction within the host truncation ceiling documented in `mcp-api`.

**The summary a model is asked for is the session's CURRENT COMPLETE state, not the delta since its last write, and the write REFINES that state rather than substituting for it.** A curated write composes with what is stored, section by section, so the stored summary is the accumulated state and each write brings part of it up to date. Every model-facing surface SHALL ask for the state that currently holds for the whole session, concise rather than exhaustive, and SHALL NOT ask for a summary whose CONTENT is "what changed since last time", "what this window did", or anything else shaped as a report of the latest turn. A model that cannot see its earlier work SHALL be directed to read the stored summary first (`memory.session_get`) rather than to write what it can see.

**Sending fewer SECTIONS is not delta framing, and the two SHALL NOT be conflated.** A curated write MAY carry only the sections that changed — that is the intended use of the merge — provided each section it carries states that section's full current state. What is prohibited is a section body that is itself a fragment, and a document that reads as a turn report. The surfaces enumerated in `mcp-api` SHALL state both halves: that an omitted `##` section keeps its stored text, and that a section which has genuinely emptied is written with an explicit short value rather than dropped, so a shrinking summary is condensation and never deletion.

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
- **AND** the displaced "A" SHALL remain readable as a version row (see "Every curated session-summary write MUST append a version row in the same transaction") — the replacement is retained, and only its destructiveness is removed
- **AND** where "A" and "B" both carry `##` headings the same last-final-wins rule SHALL apply PER SECTION rather than to the document (see "A curated session-summary write MUST be merged section-wise with the stored summary")

#### Scenario: No model-facing surface asks for a turn report

- **WHEN** every surface enumerated by the canonical-structure test is inspected
- **THEN** none SHALL instruct the model to send a summary whose content is only what is new, only what changed, or only what the current context window contains
- **AND** the `memory.session_summary` description and the `initialize.instructions` block SHALL state that a `##` section the write omits keeps its stored text
- **AND** no surface SHALL be required by this scenario to state the merge rule beyond those two — the surfaces that ask for the session's current complete state remain correct under the merge, because a complete document replaces every section

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

### Requirement: Every curated session-summary write MUST append a version row in the same transaction

The schema SHALL carry a dedicated table `session_summary_versions` whose rows are the successive stored values of one session's curated summary:

| column       | type                                                      |
| ------------ | --------------------------------------------------------- |
| `id`         | TEXT PRIMARY KEY (ULID, minted from the write's `now()`)  |
| `session_id` | TEXT NOT NULL REFERENCES `sessions(id)` ON DELETE CASCADE |
| `version`    | INTEGER NOT NULL, UNIQUE together with `session_id`       |
| `content`    | TEXT NOT NULL                                             |
| `title`      | TEXT, nullable                                            |
| `created_at` | INTEGER NOT NULL (`timestamp_ms`)                         |

No further column SHALL be added by this requirement. `title` IS versioned alongside `content` (design D22, revising D6): the dashboard renders a version's `content` next to a title, and rendering the CURRENT `sessions.title` there is misleading whenever the title changed after that version was written — the pairing, not the label alone, is what a reader needs. The stored `title` SHALL be the value in effect on `sessions.title` immediately AFTER the same update that appends the row (the `updateById` result), never the write's own argument, because `title` is optional on every curated write and an argument-based store would write `NULL` on every write that only touched `summary`.

**The invariant.** For every session with at least one row in `session_summary_versions`, `sessions.summary` SHALL equal the `content` of that session's row with the greatest `version`, and that row's `title` SHALL equal `sessions.title` as it stood immediately after the write that appended it — both come from the one `updateById` result the append reads, so they cannot disagree at that instant. The column(s) and the version row SHALL be written inside ONE `db.transaction()`, so both land or neither does; a state in which the column advanced and the row did not SHALL NOT be reachable.

This is narrower than an ongoing equality for `title`: unlike `summary`, `title` MAY change through a write that does not append a version — a title-only `final: true` write reaching the active-session branch of `end()` with no `summary` argument, reachable only via `POST /:slug/sessions/:id/end` (the `memory.session_summary` tool's schema requires `summary` on every call, so this path does not exist through MCP). Such a write leaves `sessions.title` ahead of the newest version's `title` until the next content-changing curated write appends a fresh row pairing both current values. This is documented rather than silently assumed away.

**When a row is appended.** A version row SHALL be appended by exactly those writes that store a summary value carrying `final: true` — that is, the writes that pass the `summary_final` precedence rule with an incoming `final: true`, on `writeSummary` and on `end` alike (the two write paths enumerated in "Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary`"). A write that stores nothing SHALL append nothing: this covers the terminal-row branch where an already-`final` column blocks the incoming value, and the `final: false` branch where precedence discards it.

**A `final: false` write SHALL NEVER append a version row.** The per-turn raw transcript sync every client performs is a `final: false` write, and its body is a transcript rather than a curated handoff. Versioning it would spend the table on material the summary exists to distil, at one row per turn.

**An identical re-write appends nothing.** When the value about to be stored is byte-identical to the `content` of the session's newest existing version row, no version row SHALL be appended. The column write proceeds unchanged (it stores the same bytes), so the invariant above still holds. This is what keeps the tool's published `idempotentHint: true` honest — see `mcp-api`, "Every MCP tool MUST advertise behavioral annotations", which admits a tool whose "repeated invocation is side-effect-free or last-call-wins": a retry of the same body remains exactly that.

**The versioned value is the value STORED, which since "A curated session-summary write MUST be merged section-wise with the stored summary" is the merged document rather than the write's argument.** The invariant above is unaffected — it equates the column with the newest `content`, and both are that same merged string. One consequence follows and is normative: a partial write whose sections reproduce what is already stored changes nothing, so it appends no version row, exactly as a byte-identical full re-write does not.

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

#### Scenario: The stored value and the version row are the same string, and both are capped

- **GIVEN** a curated write whose `summary` is exactly `SUMMARY_MAX_CHARS` characters, against a session with no stored curated summary (so no merge occurs)
- **WHEN** it is applied
- **THEN** `sessions.summary` and the appended version's `content` SHALL be the SAME string of that length
- **AND** the cap SHALL have been applied to that string, from the single `SUMMARY_MAX_CHARS` constant

#### Scenario: A merged write versions the merged document, not the argument

- **GIVEN** session `<S>` storing `"## Goal\nA\n## Files\nB"` with `summary_final = 1` and one version row
- **WHEN** a curated write carries only `"## Files\nB2"`
- **THEN** `sessions.summary` SHALL be `"## Goal\nA\n## Files\nB2"`
- **AND** the appended version's `content` SHALL be that same merged document, never the `"## Files\nB2"` argument
- **AND** the merged document SHALL have been checked against `SUMMARY_MAX_CHARS` before it was stored (see "Session summary writes MUST be capped at `SUMMARY_MAX_CHARS` on every write path that mutates `sessions.summary`")

#### Scenario: A partial write that changes nothing appends no version row

- **GIVEN** session `<S>` storing `"## Goal\nA\n## Files\nB"` with `summary_final = 1` and one version row
- **WHEN** a curated write carries only `"## Files\nB"`
- **THEN** the merged document SHALL be byte-identical to the stored value
- **AND** the version count for `<S>` SHALL be unchanged

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
