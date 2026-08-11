## Why

A curated session summary is replaced by a thinner one, and nothing recovers the text.

`memory.session_summary` writes `final: true` unconditionally (`apps/server/src/mcp/session-tools.ts:287-291`), and on an `active` row the precedence rule replaces the column outright — published as _last-final-wins_ in `openspec/specs/sessions/spec.md:201`: "`summary` SHALL be replaced with "B" (last-final-wins among final writes)". The reminder that triggers those writes fires on turn 1 and every 10th turn, in every client. So the second call, and the tenth, each overwrite whatever the first said.

That is harmless while the model can still see the work it already summarised. It is not harmless on a client whose compaction discards the messages it has already summarised: the model then writes a summary of the surviving window, the replace lands, and the stored value becomes ONLY that window. Dozens of turns leave no trace and no copy.

Nothing in the system can put the text back. Sessions have no `replaces` chain, and the journal cannot help: `consolidation_ops` stores IDENTIFIERS (`affected_ids`, `created_id` — `apps/server/src/db/schema/consolidation.ts`), so reversibility in this repo comes from not destroying rows, never from a stored payload. Today a summary write is an in-place `updateById` with no journal entry at all; the only `consolidation_ops` row that ever names a session is `session_purge` (`apps/server/src/services/agent-sessions.ts:694`).

Two measurements decided the shape of the fix rather than the intent behind it.

**Accumulating the text does not reach the consumer.** `memory.context` truncates a session summary to the first 350 characters — `CONTEXT_SNIPPET_CHARS = 350` (`apps/server/src/mcp/memory-tools.ts:1225`), applied at `:1309`, through a head-keeping helper (`apps/server/src/mcp/_shared.ts:359-362`, `content.slice(0, max - 1) + '…'`). Measured on a session carrying four accumulated curations (659 stored characters): **199 of the 350 preview characters were four versions of the same `Goal`**, and `Decisions+why`, `Verified+how`, `Unfinished+why` and `Files` all fell outside the window. Accumulation preserves text the consumer never reads, and the only thing it delivers is the accumulation itself.

**Accumulating the text breaks the published cap.** Measured at the HTTP boundary against a composing write: a 10 000-character sectioned argument stored **10 350** characters and the call returned `ok: true`; a 10 000-character plain body stored exactly 10 000, which is the control that makes this a fact about the write path rather than about the probe. Once the stored value is not the argument, one cap check stops being enough, and `openspec/specs/sessions/spec.md:871` requires the opposite: "The constant SHALL remain the single source of truth, exported and imported by the MCP zod schema (`apps/server/src/mcp/session-tools.ts`) and by the HTTP-layer truncation helper, so no layer can drift from the service-level cap."

So the fix is not to stop replacing. It is to make replacement non-destructive at the storage layer, and to ask the model for the artefact replacement needs.

## What Changes

- **The curated write keeps replacing, and the model is asked for the CURRENT COMPLETE state.** The model-facing instruction stops being delta-shaped ("what this window did") and asks for a concise summary of the session's standing state, **ordered current-first**. Ordering is a contract, not a style note: `memory.context` shows only the first 350 characters and `memory.session_get` returns the whole value untruncated (`apps/server/src/mcp/session-tools.ts:396`), so the head IS the preview a later model reads to decide whether to fetch the rest. Chosen over asking for a delta, because a delta is only correct if the server accumulates, and the two measurements above say accumulation is paid for and not delivered.
- **Every curated write appends one row to a new dedicated table, `session_summary_versions`, in the SAME transaction as the `UPDATE`.** Normative invariant: for a session with at least one version row, `sessions.summary` equals the `content` of its highest-`version` row. The two writes land together or neither lands. This is what makes the replace recoverable: the text that was displaced is still a row, which is the only recovery mechanism this repo has.
- **The table stays OUT of the retrieval corpus.** No new `MemoryType`, no row in `memory`. Two measured reasons: `recentForContext` excludes only `archived` (`apps/server/src/db/repositories/memory-repository.ts:140`), so `superseded` version rows would surface in `memory.context`; and decay would archive them silently at 90 days, because `thresholdByType` is `Partial<Record<MemoryType, number>>` with `defaultThresholdMs: 90 * DAY_MS` and every current type carries an explicit entry (`apps/server/src/consolidation/decay.ts:26,38-45`).
- **A byte-identical re-write appends no row.** The version row is appended only when the stored value differs from the newest version's `content`. This is what keeps the published `idempotentHint: true` claim true for this tool (`openspec/specs/mcp-api/spec.md:1549`: "Tools whose repeated invocation is side-effect-free or last-call-wins … SHALL carry `idempotentHint: true`") — a retry of the same body is still a no-op in the only sense the annotation asserts.
- **`SUMMARY_MAX_CHARS` stays at 10 000, and there is exactly ONE cap check.** It is taken on the argument, where it already is (`assertSummaryWithinCap`, `apps/server/src/services/agent-sessions.ts:75-82`), and the same string is stored in the column and in the version row. No second check is introduced, because the stored value and the argument are the same value — the property the composing alternative gave up.
- **The HTTP path does not change.** No shipped client sends `final: true` over HTTP — every write is `final: false` or omits the field (`apps/plugin/bin/rembric-plugin-core.mjs:220`, `apps/plugin/.hermes-plugin/__init__.py:526,562,589-592`, `apps/plugin/scripts/{session-end,stop-sync,pre-compact,post-compaction}.sh`) — so the raw per-turn transcript sync produces no version rows and behaves exactly as today. `end()` with a curated body appends a version row for the same reason `writeSummary` does: `openspec/specs/sessions/spec.md:885` makes the write-path enumeration normative, and a path absent from a rule of this kind "is a defect in the list or in the path, never a licensed exception".
- **The operator can read the history; nothing else can.** The existing session detail view (`/dashboard/sessions/:id`) gains a newest-first version list. Without a reader this is storage nobody consumes; with one, a displaced summary is recoverable by hand. No new MCP tool, no new HTTP route, no restore verb.
- **The per-turn reminder does NOT carry any of this, and that is a measured decision.** The `summary` nudge fixture is **259 bytes** against a published per-line cap of **260** (`openspec/specs/claude-code-plugin/spec.md:119`), and the firing-turn ceiling is ≤840 bytes against a measured worst case of 780. Teaching replacement there costs a cap edit, a re-measurement of three published aggregate figures, and per-turn tokens in five clients. The instruction goes where the model is already reading a longer text: the tool description (measured 670 of 1900 characters), `initialize.instructions` (measured 916 of 1000), the post-compaction block, the end-of-turn rubric and the slash command.
- **The post-compaction block is rewritten, because it is where the loss happens.** It currently says "Call `memory.session_summary({title, summary})` with the compact summary shown above" (`apps/plugin/test/nudge-fixtures.json::postCompact`) — an instruction to store the window, delivered at the moment the model has just lost everything else. It becomes read-then-rewrite: read the stored summary, then write the current complete state. Measured draft: 530 bytes against the published ≤600 (`openspec/specs/plugin-session-protocol/spec.md:377`).
- **A resumed process is told once to read what is stored.** A process whose first session-ensure reported `created: false` attached to a session it did not author, so it cannot know a curated summary exists. It emits one standalone line directing the model to `memory.session_get` before its next curated write. Under this design that line buys QUALITY, not safety: a model that rewrites from the real stored text produces a better full-state summary than one rewriting from an empty recollection. Safety is the version row's job.
- **The end-of-turn reminder stops going silent on an already-curated session.** The shipped hook detects the curated state from the transcript and emits nothing, which contradicts `openspec/specs/plugin-session-protocol/spec.md:487` ("the reminder is cadence-gated and may fire on a session that has already been summarised") and freezes a premature first write, because nothing ever asks the model to improve it.

### Rejected, with the reason

- **A read-back proof (require the model to echo the stored summary before overwriting).** Rejected: it converts a write into two round-trips, it is unenforceable against a model that echoes and then still writes a window, and the version row already makes the overwrite recoverable. Cost with no marginal safety.
- **A shrink guard (refuse or downgrade a write much shorter than the stored one).** Rejected: a correct summary legitimately shrinks — a session that abandons three approaches ends with less standing state than it accumulated — so the guard's false-positive case is the desirable one, and there is no measured threshold that separates the two.
- **Accumulating in the column (merging sections server-side).** Rejected on the two measurements in `## Why`.
- **A row in `memory` instead of a dedicated table.** Rejected on the `recentForContext` and decay measurements above.
- **Versioning `title` too.** Rejected: `title` is ≤100 characters and a lost label costs a re-read of the summary, not a re-derivation of the session.

### Dismantling in scope

This change also retires the abandoned section-merge line of work, and the retirement is part of the deliverable rather than a footnote: the superseded change folder is **deleted, not archived**, and four independent commits are rescued onto a branch cut fresh from `origin/main`. `design.md` D11–D12 record why deletion is the correct disposal and what each rescued commit is worth; `tasks.md` phase 0 enumerates the steps, including the model-facing text that arrives with the rescued commits and describes a merge that will not exist.

## Capabilities

### New Capabilities

None. The behaviour lands inside existing capabilities.

### Modified Capabilities

- `sessions` — the version table and its append-only contract, the curated-write/version invariant, the identical-content skip, the current-state ordering of the canonical structure, the purge cascade.
- `mcp-api` — the `memory.session_summary` description obligations (replaces, current complete state, current-first ordering, read-before-rewrite) and the `initialize.instructions` clause within the published 1000-character cap.
- `persistence` — migration `0033_session_summary_versions.sql`: additive, no backfill, `ON DELETE CASCADE`, first boot on a populated file.
- `data-access` — `AgentSessionsRepository` owns the new table (the published repository/table enumeration names one table per repository today).
- `dashboard` — the session detail view lists the summary version history.
- `plugin-session-protocol` — the post-compaction read-then-rewrite block, the resumed-process read line, the end-of-turn reminder's silence removal, and the recorded reason the per-turn nudge text is unchanged.

## Impact

**Schema.** One new table, one migration, no change to any existing column. Additive on a populated file; no backfill, so pre-existing sessions start with an empty history.

**Server.** `apps/server/src/services/agent-sessions.ts` (transaction + version append at the single precedence site), `apps/server/src/db/repositories/agent-sessions-repository.ts` (insert + `admin*` read), `apps/server/src/db/schema/agent-sessions.ts` (new table), `apps/server/src/db/migrations/0033_session_summary_versions.sql`, `apps/server/src/mcp/server.ts` + `apps/server/src/mcp/instructions.ts` (model-facing text), `apps/server/src/dashboard/sessions.ts` (history section), `apps/server/src/test/schema-inventory.ts` (`SOURCE_TABLES`), `apps/server/src/test/invariants.test.ts` (append-only rules for the new table).

**Plugin.** Text only; the HTTP protocol is unchanged. The surfaces pinned by `apps/server/src/test/invariants.test.ts::"the session-summary rubric has one source"` are `apps/server/src/mcp/instructions.ts`, `apps/server/src/mcp/server.ts`, `apps/plugin/scripts/prompt-nudge.sh`, `apps/plugin/scripts/stop-nudge.sh`, `apps/plugin/scripts/post-compact.sh`, `apps/plugin/commands/summary.md`, `apps/plugin/bin/rembric-plugin-core.mjs`, `apps/plugin/.hermes-plugin/__init__.py`; the cross-language contract is `apps/plugin/test/nudge-fixtures.json`. `.hermes-plugin/__init__.py::system_prompt_block` must stay byte-identical to `instructions.ts::BASE` and is pinned by `apps/plugin/.hermes-plugin/tests/test_system_prompt_block.py`.

**Existing installations.** First boot after upgrade runs one `CREATE TABLE`; no row is read or written. Nothing derived needs invalidating — `memory_fts`, `memory_vec` and the three entity tables are untouched, and the new table is a SOURCE table, not a derived one. Rolling back to a pre-migration image leaves the table present and unread; `sessions.summary` remains the authoritative current value on both sides, so no summary is lost by a downgrade.

**Storage.** Bounded by curated writes × `SUMMARY_MAX_CHARS`. A 100-turn session at the every-10th cadence is ≤10 rows; at the cap that is ≤100 KB for the heaviest session, against a 659-character measured real one.
