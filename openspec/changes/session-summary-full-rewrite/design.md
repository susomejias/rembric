## Context

`memory.session_summary` replaces `sessions.summary` on every curated call, the reminder that triggers it fires on turn 1 and every tenth turn, and a client whose compaction discards already-summarised messages therefore stores a summary of the surviving window. The text that was there is gone: sessions have no `replaces` chain, and `consolidation_ops` journals identifiers rather than payloads, so no existing mechanism can return it.

The whole design space was explored before this document. What follows records the decisions and their evidence, not a survey.

Two measurements are load-bearing throughout and are stated once here.

**M1 — the consumer reads only the head.** `CONTEXT_SNIPPET_CHARS = 350` (`apps/server/src/mcp/memory-tools.ts:1225`) is applied to a session summary at `:1309` through a head-keeping helper (`apps/server/src/mcp/_shared.ts:359-362`). Measured on a session with four accumulated curations (659 stored characters): 199 of the 350 preview characters were four versions of the same `Goal`, and `Decisions+why`, `Verified+how`, `Unfinished+why` and `Files` were all outside the window. `memory.session_get` returns the value in full (`apps/server/src/mcp/session-tools.ts:396`), so the 350 characters are an ANTICIPO — the preview on which a later model decides whether to fetch the rest.

**M2 — a composing write breaks the single cap.** Measured at the HTTP boundary against a write that canonicalises and merges: a 10 000-character sectioned argument stored 10 350 characters and the call returned `ok: true`; a 10 000-character plain body stored exactly 10 000. The plain control is what makes this a fact about the write path rather than about the fixture. Once the stored value is not the argument, one check on the argument stops bounding storage, and `openspec/specs/sessions/spec.md:871` requires the constant to remain "the single source of truth … so no layer can drift from the service-level cap".

## Decisions

### D1 — The curated write keeps replacing; accumulation is rejected

M1 says accumulation preserves text the consumer never reads and delivers only the accumulation. M2 says accumulation forces a second cap check on a value the agent never sees, which is the property the published cap requirement exists to prevent. Replacement is also already the published contract (`openspec/specs/sessions/spec.md:201`), so keeping it means the surrounding requirements stay coherent instead of being re-derived.

What was actually wrong was not the replacement but its destructiveness. D4 removes that.

### D2 — The model is asked for the session's CURRENT COMPLETE state

If the server replaces, a delta-shaped instruction is a bug in the instruction. Every model-facing surface therefore asks for the state that currently holds for the whole session, concise rather than exhaustive, and none asks for "what changed", "what this window did" or "what's new".

The most consequential instance is the post-compaction block, which today says to call the tool "with the compact summary shown above" — an instruction to store the window, delivered at the one moment the model has nothing else. That is the proximate cause of the loss and it is rewritten to read-then-rewrite.

### D3 — The summary is ordered current-first, and the server does not enforce it

By M1 the first characters ARE the preview. So what the model writes first is what a later session sees, and ordering is a contract rather than a presentation preference. The server does not enforce it, consistent with the published requirement that the layout is documented but unenforced — an enforced layout would reject free-form text a weak model produces, which is worse than an unordered summary.

The alternative — lowering `CONTEXT_SNIPPET_CHARS` so more of the summary reaches the model — was rejected: it is one bound shared by every text field in `memory.context`, and lowering it to serve summaries shrinks memory snippets and prompt previews for nothing. Raising it for summaries alone reintroduces the per-field divergence a published requirement exists to remove.

### D4 — One version row per curated write, in the same transaction as the `UPDATE`

`session_summary_versions` gets one row per curated write, appended inside the same `db.transaction()` as the column write, with the normative invariant: for a session with at least one version row, `sessions.summary` equals the `content` of its highest-`version` row.

Two rejected alternatives, both cheaper and both insufficient:

- **Journal it in `consolidation_ops`.** Impossible: that table stores `affected_ids` and `created_id` (`apps/server/src/db/schema/consolidation.ts`), so it can name what happened but never restore a payload. Reversibility in this repo comes from not destroying rows.
- **Store the previous value in a second column on `sessions`.** A one-deep history loses the second overwrite, which is exactly the case the cadence produces (turn 1, 10, 20, 30 …), and it would make `sessions` carry a second mutable text column with its own precedence question.

The transaction is not decorative. A column that advanced without its row would make the invariant unfalsifiable in the direction that matters — the state where the text is gone and nothing recorded it.

### D5 — A dedicated table, outside the retrieval corpus

No new `MemoryType`, no row in `memory`. Two measured reasons:

- `recentForContext` filters only `archived` (`apps/server/src/db/repositories/memory-repository.ts:140`), so `superseded` version rows would surface in `memory.context` — the corpus would start returning old summaries as if they were current memories.
- Decay would archive them silently at 90 days: `thresholdByType` is `Partial<Record<MemoryType, number>>` with `defaultThresholdMs: 90 * DAY_MS`, and every current type carries an explicit entry (`apps/server/src/consolidation/decay.ts:26,38-45`), so a new type inherits the fallback rather than a considered window.

Adding a type to fix both means teaching decay, review TTLs, the type filters, the dashboard facets and the retrieval evaluation about a row nobody should retrieve. A dedicated table teaches nothing anything.

### D6 — Minimal columns; no extra index (title-versioning half reversed by D22)

`id`, `session_id`, `version`, `content`, `created_at`, `title` (added by D22, see below) and nothing else. `token_id` and `agent` are already on the parent row; a `final` column would be constant-true by construction; a source column (`mcp` vs `http`) would record a distinction the invariant already makes (only curated writes append).

This decision originally also rejected versioning `title`, on the reasoning that it is ≤100 characters and a lost label costs a re-read of the summary, not a re-derivation of the session. **D22 reverses that half**, kept here rather than silently edited: the column list above already reflects the reversal.

One named unique index on `(session_id, version)` is declared and nothing further. It serves both reads the design has (newest row for one session; all rows for one session, ordered), and being named rather than an anonymous table-level `UNIQUE (…)` auto-index is what puts it in the schema-drift inventory alongside every other index here. Adding an index without a measurement is a write cost against an unestablished read benefit — the discipline this repo already applies to query changes.

### D7 — The first curated write appends `version = 1`, even when nothing was stored before

_Open question 3, closed._ The alternative — append only when something is overwritten — makes the table a partial history that no reader can interpret: the surviving entry would be numbered 2 with no findable predecessor, and the dashboard would present the origin of the text as missing rather than as absent. It also breaks the invariant's simple form, because a session's column would carry curated text with no corresponding row.

Cost of versioning the first write: one row per curated session, ≤10 KB.

### D8 — Exactly one cap check, on the argument

_Open question 4, closed._ The cap is checked where it already is — `assertSummaryWithinCap` on the argument (`apps/server/src/services/agent-sessions.ts:75-82`) — and the SAME string is written to the column and to the version row. No second check is introduced anywhere.

This is only available because of D1. Under a composing write the stored value differs from the argument (M2: 10 350 stored for a 10 000 argument), which forces a second check on a value the agent cannot predict and puts the published requirement — "The constant SHALL remain the single source of truth … so no layer can drift from the service-level cap" (`openspec/specs/sessions/spec.md:871`) — permanently under strain. Replacement makes the argument and the stored value the same string, so one constant genuinely governs every layer.

### D9 — `ON DELETE CASCADE`, and the purge stays the one escape hatch

_Open question 1, closed._ The FK is `REFERENCES sessions(id) ON DELETE CASCADE`.

Under today's predicate the cascade never fires: purge-eligibility requires that no summary text was ever written, and a session with a version row has a non-NULL `summary` by D4's invariant. So the choice is about the failure mode if that ever changes. A default `NO ACTION` FK would abort the whole purge batch with `FOREIGN KEY constraint failed` (`purgeByIds` deletes by `id IN (…)` in one statement), turning an operator action into an unexplained failure. Cascade keeps the purge total.

Cascade also adds no `DELETE` statement to the codebase, so the two-sided allow-list that pins `DELETE FROM sessions` to one repository file does not have to grow — the append-only gate keeps exactly the shape it has.

What cascade does NOT buy: recoverability of a purged session's versions. The `session_purge` journal names ids, so those rows are gone in the same sense the session row is. The spec says so rather than implying otherwise.

Consequence recorded for a future author: `sessions` now has another populated child, so a future table-rebuild migration on `sessions` must recreate this FK. The runner's `PRAGMA foreign_keys = OFF` → `BEGIN IMMEDIATE` → body → `PRAGMA foreign_key_check` → `COMMIT` sequence is what makes such a rebuild possible at all.

### D10 — The operator reads the history on the existing session detail page

_Open question 2, closed._ Without a reader this is storage nobody consumes. The reader is a `SUMMARY HISTORY` section on `/dashboard/sessions/:id`, newest first, each entry showing version, `formatTs(created_at)`, character count and the FULL content, collapsed by default with native HTML disclosure (the dashboard ships no JS build pipeline).

Rejected: a per-version route (`/dashboard/sessions/:id/summary/:version`) — a second route and template for text that fits on the page it belongs to; a preview-only list — it cannot serve the section's only purpose; a new MCP tool or HTTP route — the history is an audit surface, and `memory.session_get` already gives a model the value it needs to rewrite; a restore action — a new mutation verb, deferred (D19).

### D11 — The superseded change folder is DELETED, not archived

The abandoned section-merge line of work has a change folder with a full set of artifacts. It is deleted outright.

Verified before deciding: `grep -rn "MUST merge into the stored summary\|newest-first\|replaceStoredSummary\|canonical layout" openspec/specs/` returns ZERO matches, so nothing it specified was ever published and abandoning it costs no published requirement. `openspec archive` would MERGE its ~27 requirement entries across 6 capabilities into the published specs, and undoing that afterwards would take a second change carrying ~27 `## REMOVED Requirements` entries, each needing a Reason and a Migration for a contract that never shipped.

This is the part that is easy to forget and irreversible in the wrong direction: archiving is cheap to do and expensive to undo, deletion is the opposite. The branch carrying that work stays unmerged and unpushed as a reference; it is neither merged nor reverted commit-by-commit.

### D12 — Four commits are rescued onto a branch cut from `origin/main`

Work already paid for and independent of the abandoned design, in the order it should land:

- **The spec gates** (`scripts/check-delta-sections.mjs` + its test, `scripts/check-spec-crossrefs.mjs`). They catch a misfiled delta requirement and a citation pointing at no requirement. Design-independent, and this change is itself a six-file delta that benefits from both.
- **The `resumedRead` line** (client implementations plus `resumed-read.test.ts` and `test_resumed_read.py`). Its justification CHANGES under this design and the change is honest: it no longer carries safety, because D4 does. It buys the QUALITY of the rewrite — a model that reads the stored text rewrites from what is actually there instead of from an empty recollection, which is precisely what D2 asks it to produce. The line's own wording ("call `memory.session_get` before your next `memory.session_summary` write") is design-agnostic and needs no edit.
- **The `stop-nudge.sh` silence fix.** The shipped hook detects an already-curated session from the transcript and emits nothing, which contradicts the published cadence guarantee and freezes a premature first write forever, because nothing afterwards asks the model to improve it.
- **The fixture `TMPDIR` change in `vitest.config.ts`**, so an aborted run costs disk rather than RAM.

**The trap, and it is the reason a rescue is not a cherry-pick.** Those commits were authored on top of the merge design, and their diff context carries model-facing text that describes it — the clause "Merges into the stored summary and keeps what you omit — add what's new" and its variants, across `prompt-nudge.sh`, `stop-nudge.sh`, `post-compact.sh`, `rembric-plugin-core.mjs`, `.hermes-plugin/__init__.py`, `mcp/server.ts`, `mcp/instructions.ts` and `nudge-fixtures.json`. Landing it would publish an instruction for behaviour that will not exist. `tasks.md` phase 0 therefore has one task per pinned surface, and the surface list is taken from `apps/server/src/test/invariants.test.ts::"the session-summary rubric has one source"` rather than from memory: the enumeration there is asserted complete by a `git grep`, so a surface left behind fails the build.

### D13 — The new instruction goes where there is measured headroom, and NOT into the per-turn reminder

Measured on `origin/main`:

| surface                                 | measured  | published ceiling               |
| --------------------------------------- | --------- | ------------------------------- |
| `summary` nudge fixture                 | 259 bytes | 260 bytes (per-line cap)        |
| `initialize.instructions` (unscoped)    | 916 chars | 1000 chars                      |
| `initialize.instructions` (path-scoped) | 902 chars | 1000 chars                      |
| `memory.session_summary` description    | 670 chars | 1900 (`DESCRIPTION_MAX_LENGTH`) |
| `postCompact` fixture                   | 574 bytes | 600 bytes                       |

The per-turn reminder has ONE byte of headroom. Adding the replace-and-rewrite clause there costs a per-line cap edit plus a re-measurement of three published aggregate figures (per-firing-turn ≤840 bytes against a measured 780 worst case, the turn-1 sub-budget, and the amortised figure), and it is paid on turn 1 and every tenth turn in five clients — to teach a distinction only a model about to curate needs.

So the clause goes into: the tool description (1230 characters spare), `initialize.instructions` (a 68-character clause measured to land at 984 of 1000), the post-compaction block (a rewrite measured at 530 of 600 bytes), the end-of-turn rubric (no published per-line cap, and it fires immediately before a write) and `commands/summary.md` (no budget). The per-turn `summary`/`summaryCore` fixtures stay byte-identical to `origin/main`, so no published byte figure needs re-measuring.

The measurement also settles a related temptation: `instructions.ts::BASE` must stay byte-identical to Hermes's `system_prompt_block()`, so the clause lands in both or `test_system_prompt_block.py` fails. That pinning is a feature here — it makes the Python client impossible to forget.

### D14 — A read-back proof is rejected

Requiring the model to echo the stored summary before an overwrite would double the round-trips of the most frequent write in the protocol, and it is unenforceable in the direction that matters: a model can echo the stored text and still write only its window. The version row makes the overwrite recoverable regardless of what the model read, which is the guarantee a proof was reaching for.

### D15 — A shrink guard is rejected

A rule that refuses or downgrades a write much shorter than the stored value has its false positives exactly where the desirable behaviour is: a session that abandons three approaches ends with LESS standing state than it accumulated, and a correct current-state summary is often shorter than the accumulated one. There is no measured threshold separating that from the loss case, and a guard whose failure mode is refusing correct writes on a tool the model must call at end of turn is worse than the loss it prevents — which D4 already prevents anyway.

### D16 — The HTTP path does not change, and `end()` is still covered

No shipped client sends `final: true` over HTTP: every write is `final: false` or omits the field (`apps/plugin/bin/rembric-plugin-core.mjs:220`, `apps/plugin/.hermes-plugin/__init__.py:526,562,589-592`, `apps/plugin/scripts/{session-end,stop-sync,pre-compact,post-compaction}.sh`, the last of which documents the precedence it relies on). So in practice the raw per-turn sync writes no version rows and behaves exactly as today — no new response field, no new status code, no protocol change.

`end()` is nonetheless covered by the append rule, because the published cap requirement makes the write-path enumeration normative: "a write path absent from this list is a defect in the list or in the path, never a licensed exception" (`openspec/specs/sessions/spec.md:885`). A curated body arriving through `/end` is a curated write, and leaving it unversioned would create a second way to overwrite curated text — the exact hole this change closes.

### D17 — No backfill

A version row asserts that its `content` was the stored summary as of its `created_at`. For a summary written before this change, that timestamp is not recorded anywhere: `sessions` carries `started_at`, `ended_at` and `last_activity_at`, and none of them is when a summary was written. A backfill would have to invent the one field the row exists to carry.

So the invariant is deliberately scoped to sessions that HAVE at least one version row, which is what makes it hold on a populated file from the first boot after upgrade. Pre-existing sessions show an empty history section, and their first post-upgrade curated write starts at `version = 1` with the NEW text.

### D18 — A byte-identical re-write appends no row

Models retry. Two identical curated writes would otherwise produce two identical rows, which adds nothing to the audit and turns the history into a duplicate log.

It also keeps a published claim honest rather than requiring its correction: `openspec/specs/mcp-api/spec.md:1549` admits `idempotentHint: true` for tools "whose repeated invocation is side-effect-free or last-call-wins", and with the skip, a repeat of the same body still has no additional effect. Without the skip the annotation would become false and the alternative would be flipping it to `false` — a worse outcome for a tool the model is told to call at every working turn's end, because hosts use the hint to decide whether a retry is safe.

The comparison is against the newest version's `content` only, not against the whole history: reverting to an older text IS a new event and gets its own row.

### D19 — No restore verb, and no version read for models (the read half reversed by D20)

Deferred deliberately, not forgotten. Recovery today is an operator reading the version on the dashboard and handing the text back through the ordinary curated write path, which produces a new version row and leaves the history honest. A `restore` action would be a new mutation verb whose result is indistinguishable from that write.

This decision originally also rejected any model-facing history read, reasoning that it "would put superseded summaries in front of the model that is supposed to be writing the current one." **D20 reverses that half** — a BOUNDED, EXCEPTIONAL read, not an unbounded one — for the reason given there. The no-restore-verb half is unchanged: recovery is still an operator or a model handing text back through the ordinary curated write.

### D20 — `memory.session_get({ limit })`: a bounded, scoped model read of the version history

D19's blanket "no version read for models" is reversed for the reason it was written to avoid: an operator-only history serves nobody who can only act through the agent itself. The common recovery case is not "an operator notices and pastes text back" — it is "the model's own context is gone and it needs its own earlier detail to write a correct current-state summary next", and only a model-callable read can serve that case at all.

Reversing it now, before this change publishes, costs nothing a published requirement would: the requirement being changed (`sessions`, "No new read surface") lives only in `openspec/changes/session-summary-full-rewrite/specs/`, not yet in `openspec/specs/`, so this is an edit to this change's own still-unpublished artifact, not a `REMOVED`/`MODIFIED` pair against a shipped contract.

The surface stays narrow, for the reasons D5 and D19 kept the table out of ordinary reach in the first place:

- **No new field on `memory.context`, no HTTP route.** Only one tool gains one optional argument.
- **`limit`, not `versions`, is the parameter name** — matching this repo's existing size-bounding convention (`z.number().int().min(0).max(X).optional()`, e.g. `contextSchema`'s `sessions`/`prompts`/`memories`, `apps/server/src/mcp/memory-tools.ts:247-249`). The tradeoff of that name: on `memory.search`, `limit` narrows a list the tool already returns; on `memory.session_get`, which returns one object, a bare `limit` invites the same reading — bounding the ONE summary, or its length — rather than the actual meaning, "how many past versions to also attach". The description carries the disambiguation explicitly (see `mcp-api`) rather than relying on the name alone, because the name alone is genuinely ambiguous here. The bounding constant is named for what it bounds regardless of the parameter's name: `SESSION_GET_VERSIONS_MAX = 5`.
- **Omitted or `0` is byte-identical to before this argument existed** — no `versions` field, not an empty array — so no existing caller pays anything. This is the same "additive, zero-cost-when-unused" shape `SESSION_GET_VERSIONS_MAX` shares with every other context-tool maximum.
- **A positive `limit` returns full, untruncated `content`.** The use case is recovering text to fold into the next rewrite; a truncated recovery would force a second round-trip, the exact cost `memory.session_get` already exists to avoid for the current summary.
- **The read is resolved against `Scope` by a dedicated repository method** (`listSummaryVersionsInScope`), not the dashboard's unscoped `admin*` read: it applies the scope condition in the query itself rather than trusting the handler's prior `not_found` check, matching every other scoped repository method in this codebase (`CLAUDE.md`, "Scope enforced at service layer").
- **The tool description states the read is EXCEPTIONAL.** Routine use would reintroduce exactly the failure mode D2 exists to prevent — a model reading stale sections instead of writing the current state. The description exists to say: use this only when a rewrite dropped detail you need back, never as a matter of course.

Measured: the reworded `memory.session_get` description is 652 characters against the 1900-character `DESCRIPTION_MAX_LENGTH` ceiling (verified again from a live `tools/list` response in `apps/server/src/test/mcp-integration.test.ts`).

## Risks

- **A model that writes a full state every ten turns spends more tokens per call than one writing a delta.** Accepted: M1 says the delta's savings were never delivered to a reader, and the cap already bounds each call at 10 000 characters.
- **A weak model may write a thin full-state summary and store it.** The version row makes that recoverable, which is the whole point; the reminder firing again (D12's silence fix) is what gives the next turn a chance to improve it.
- **Storage grows with curated writes.** Bounded by writes × `SUMMARY_MAX_CHARS`: ≤10 rows for a 100-turn session at the every-tenth cadence, ≤100 KB at the cap, against 659 characters measured on a real four-curation session.
- **The dashboard page grows with the history.** Resolved by D21: capped at `SUMMARY_HISTORY_MAX` (20), newest first, with a "showing N of TOTAL" note.
- **A title-only final write can leave `sessions.title` ahead of the newest version's title.** Accepted and documented rather than solved (D22): the only such path is `POST /:slug/sessions/:id/end` with `title` and no `summary`, unreachable through `memory.session_summary` (whose schema requires `summary`). The next content-changing curated write re-pairs both values in a fresh row.

### D21 — The dashboard history section is capped at `SUMMARY_HISTORY_MAX = 20`, newest shown, fixed cap over pagination

The risk flagged at proposal time ("If a measured page weight ever justifies a bound, the bound is a spec edit with the measurement attached — not a silent `LIMIT`") is now realized, found while implementing this same change rather than reported separately: at the every-10th-turn cadence a 300-turn session carries ~31 version rows and a 1000-turn session ~101, and at the per-write cap (`SUMMARY_MAX_CHARS = 10000`) that is a page of several hundred KB to ~1 MB, unbounded — the section's collapsed-by-default `<details>` elements bound what is VISIBLE, not the bytes the server sends.

**Fixed cap, not pagination.** The section already exists to serve "recover the newest few versions a recent rewrite dropped"; the versions that matter most for that are the newest ones, which a fixed newest-N window serves directly. Pagination would need a page query parameter and a route the original design (D10) deliberately kept off this page ("no new route, no form"); a fixed cap needs neither, and is therefore the minimal fix.

**The number: 20.** At the 10 000-character cap that bounds the section to ≤200 KB even in the reported worst case — an order of magnitude below the ~1 MB pathological case — while still showing roughly twice the every-10th-turn depth of a 200-turn session. It is the same order of magnitude as this codebase's other "how many of these does one view render" constants (`CONTEXT_SESSIONS_MAX = 25`, `PENDING_JUDGMENTS_MAX = 50`), scaled down because this section's rows are far heavier (full markdown bodies, not list rows).

**The heading keeps the TOTAL count** (`adminCountSummaryVersions`, a cheap `COUNT(*)`, not the length of the rendered page), and when the total exceeds what is rendered, a line states how many are shown and how many exist — the omitted versions are still in the table, never implied lost.

### D22 — `session_summary_versions` also stores `title` — the value in effect, not the write's argument

D6 rejected versioning `title`: a lost label costs a re-read of the summary, not a re-derivation of the session. True for the LABEL alone, but wrong for the PAIR the dashboard actually renders: a version's `content` next to the CURRENT `sessions.title` is misleading whenever the title changed after that version was written — a v1 body would sit under a title minted for v3. Reversed here, in the same still-unpublished change, for the identical reason D20 reverses D19's other half.

**Column:** `title TEXT`, nullable (a session can be curated before it has a title), added to the same still-unreleased migration `0033` rather than a new one — nothing on this branch is pushed, `0033` has never shipped in a release, and a second migration describing a column on a table no release ever had would be pure noise for a future reader.

**Which value is stored:** the title in effect on `sessions.title` immediately AFTER the update that appends the row (`updated.title`, the `updateById` result) — never the write's own argument. `title` is optional on every curated write (`sessionSummarySchema`), so an argument-based store would write `NULL` on every write that only touched `summary`, even when the session already has a title live. Storing the post-update value is what pairs the version with the label that was actually live alongside it, regardless of whether this particular call touched it.

**The invariant, extended, and where it stops.** The newest version's `title` SHALL equal `sessions.title` immediately after the write that appended it — both come from the same `updateById` result. This is narrower than the `summary` invariant's wording: unlike `summary`, `title` CAN change through a write that appends no version — a title-only `final: true` write on the active-session branch of `end()` with no `summary` argument. That path exists only through `POST /:slug/sessions/:id/end` (`memory.session_summary`'s schema requires `summary` on every call, so the path does not exist through MCP). Such a write leaves `sessions.title` ahead of the newest version's `title` until the next content-changing curated write. Stated explicitly rather than assumed away, and covered by a regression test that demonstrates the divergence rather than merely asserting the invariant holds (`apps/server/src/services/agent-sessions.test.ts`).

## Existing installations

One `CREATE TABLE` at first boot; no row read or written; every existing column untouched. Nothing derived needs invalidating — `memory_fts`, `memory_vec` and the three entity tables do not derive from the new table, which is classified as a SOURCE table in the shared schema inventory. Rolling back to a pre-migration image leaves the table present and unread, with `sessions.summary` still authoritative on both sides, so a downgrade loses no summary. The dashboard's new section renders as empty for every session that pre-dates the upgrade, which D17 makes the correct display rather than a defect.

## Open questions

1. **Does the operator eventually want a one-click restore?** Default for this change: no (D19). Worth revisiting only if the dashboard history is actually used to recover text and the copy-paste step proves to be the friction.
2. **Should the sessions LIST view show a version count column?** Default: no. The count is only meaningful next to the text it counts, and the list view already carries the discipline that a column has to earn its width (`openspec/specs/dashboard/spec.md:1188`, "List tables MUST NOT spend a column on row ids").
3. **Two published requirements disagree about the `summary` length `CHECK`, independently of this change.** `openspec/specs/persistence/spec.md:568` still requires `CHECK (summary IS NULL OR length(summary) <= 2000)`, while `openspec/specs/sessions/spec.md:869` requires that the `CHECK` introduced in migration `0011` "SHALL be removed by a table-rebuild migration" and that no `CHECK` pin the cap — which is what the code does (`0012_drop_summary_length_check.sql`). This change adds a `persistence` requirement and deliberately does not touch that one: correcting a published contradiction is its own change, and folding it in here would mix an unrelated `REMOVED`/`MODIFIED` pair into a delta reviewers need to read against the summary-loss defect. Flagged so it is not lost.
4. **The published `Stop | 0 tokens` figure in `claude-code-plugin` is false today**, on `origin/main`, because `stop-nudge.sh` emits `additionalContext`. D12's silence fix makes the hook fire more often but does not make a true statement false. Not corrected here for the same reason as (3).
