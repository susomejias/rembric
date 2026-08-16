## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Every curated session-summary write MUST append a version row in the same transaction

**Reason**: The requirement exists to make whole-document replacement recoverable, and "A curated session-summary write MUST be merged section-wise with the stored summary" removes whole-document replacement. Recoverability now comes from preservation by omission — a `##` section the write does not carry survives byte-identically, and a curated write carrying no `##` heading at all against a sectioned stored summary is refused — rather than from a historical copy. The two shapes the version rows were bought to survive (a forgotten section, and six sections collapsed into one paragraph) are no longer reachable. The one shape that remains, a section the write carries rewritten thinner than what it replaces, is an accepted risk recorded in "A session summary MUST follow the documented structure" and is not protected by any mechanism.

The requirement's one clause with independent value, **One site**, is not lost: that per-field precedence is folded into an update `set` in exactly one place shared by all three write paths is published independently by "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`", and the merge requirement's cross-reference now points there.

**Migration**: A migration drops `session_summary_versions` (`persistence`, "The `session_summary_versions` table MUST be dropped by a dedicated migration, with `0033` retained on disk"). Every stored version row is destroyed and is not recoverable — `consolidation_ops` records identifiers, never payloads. Operators wanting the history take a `sqlite3 .backup` before the upgrade, per `docs/backup.md`. `sessions.summary` is untouched, so no session summary is lost. `updateAndVersion` collapses to a plain `updateById` at its three call sites; `memory.session_get`'s `limit` argument is removed (see this capability's `memory.session_get` requirement) and the dashboard's `SUMMARY HISTORY` section is removed with it (`dashboard`).

### Requirement: `session_summary_versions` rows MUST be append-only, and removable only with their session

**Reason**: The table is dropped, so there is no row to protect, no cascade to declare and no static-grep pin to maintain. The four forbidden-pattern rules naming `session_summary_versions` in the invariants suite are removed with it; the `memory`, `sessions`, `prompts` and `memory_relations` pins in the same family are unaffected.

**Migration**: `session_summary_versions` is removed from `SOURCE_TABLES` in the shared schema inventory and from the schema-drift index snapshot (both the named unique index and its autoindex). The purge predicate is unchanged and needs no replacement clause: what actually keeps a summarised session out of the physical purge is clause 1 of "Sessions MAY be physically purged when empty" — any summary text at all, curated or raw, makes the session ineligible — not the presence of a version row. The service test asserting that predicate SHALL be rewritten to assert against the `summary` column rather than deleted, so predicate coverage is not silently dropped along with the table.
