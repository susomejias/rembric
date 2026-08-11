## ADDED Requirements

### Requirement: A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist

A process whose FIRST `POST /api/<slug>/sessions` of its lifetime reports `created: false` attached to a session it did not author. It cannot know whether a curated summary is already stored, and the model driving it cannot see the turns that produced one. It SHALL therefore emit, once, a standalone line directing the model to read the stored summary (`memory.session_get`) before its next curated write.

**What the line buys is the QUALITY of the rewrite, not the safety of it.** Safety is the server's: a curated write is recorded as a version row before it can displace anything (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"), so a model that never reads first can no longer destroy text. What it can still do is write a worse summary — rebuilding the session's state from an empty recollection instead of from the text that is actually stored. The line closes that gap and nothing else, so its absence SHALL cost correctness nothing.

The line SHALL be governed by four constraints:

- **Sourced from the shared fixture contract** (`apps/plugin/test/nudge-fixtures.json`'s `resumedRead` key) and byte-identical across clients, on the same discipline as every other nudge line.
- **Emitted as its own line**, never interpolated into the summary reminder. There SHALL still be exactly ONE summary-reminder string whose content depends on no session state; a state-dependent variant of that string is REJECTED, because one string has to be true in both states and a claim about state is the one thing a state-blind reminder cannot make.
- **Once per session id per process.** The resumed verdict SHALL be latched from the FIRST ensure of the process and SHALL NOT be recomputed; the emission SHALL be gated so a later firing of the reminder does not repeat it.
- **No new request.** The verdict SHALL be read from the response of the session-ensure the client already makes. No client SHALL issue a request whose only purpose is to learn whether a stored summary exists, and no client SHALL read the response body of a summary POST to obtain summary state. This keeps the reminder's existing contract intact: the reminder consults the transcript and the counter, and the CLIENT still asks the server nothing — it is the MODEL that is directed to call an MCP tool.

An unknown outcome — a failed ensure, or a response with no `created` field — SHALL be treated as "do not advise", never as "advise anyway". Where the marker that carries the verdict between two processes cannot be read, the line SHALL be suppressed rather than guessed.

The verdict marker SHALL remain write-once per session id. The write-once property is what stops every post-startup re-ensure's `created: false` from claiming a freshly-created session was resumed, and it SHALL NOT be relaxed in order to re-arm the line at a compaction boundary — that re-arm is a separate act, specified in "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full".

#### Scenario: A resumed session gets the read line once

- **GIVEN** a client whose first `POST /api/<slug>/sessions` of the process returned `created: false`
- **WHEN** the summary reminder fires for the first time in that process
- **THEN** the client SHALL emit the `resumedRead` line as its own line alongside the reminder
- **AND** it SHALL NOT emit it again on any later firing in the same process

#### Scenario: A freshly created session never gets the read line

- **GIVEN** a client whose first `POST /api/<slug>/sessions` of the process returned `created: true`
- **WHEN** the summary reminder fires at turn 1 and at every later cadence point in that process
- **THEN** the `resumedRead` line SHALL NOT be emitted at all

#### Scenario: A failed ensure suppresses the line rather than guessing

- **GIVEN** a client whose first `POST /api/<slug>/sessions` of the process failed, or returned no `created` field
- **WHEN** the summary reminder fires
- **THEN** the reminder SHALL be emitted and the `resumedRead` line SHALL NOT

#### Scenario: The line does not become a second summary variant

- **WHEN** the shared fixture contract and every client's reminder path are inspected
- **THEN** there SHALL still be exactly one summary-reminder string, unchanged in content by this requirement
- **AND** `resumedRead` SHALL be a separate key emitted as a separate line, never interpolated into it

#### Scenario: No per-turn state is retained and no extra request is made

- **WHEN** the shared JS/TS core, the bash scripts and the Python provider are inspected
- **THEN** none SHALL read the response body of any summary POST to obtain summary state
- **AND** none SHALL issue a request whose only purpose is to learn whether a stored summary exists

### Requirement: The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full

A compaction is the moment at which the stored summary matters most and is least visible: the model that continues has lost the turns it would summarise, and this injection is the only instruction it receives before it acts. The block SHALL therefore be ordered read-then-write:

1. Read the stored summary (`memory.session_get`).
2. Write the session's CURRENT COMPLETE state with `memory.session_summary` — what was just read, brought up to date with the surviving window — and SHALL be told that the write replaces the stored value, so sending the window alone stores the window alone.
3. Recall further prior context (`memory.context` / `memory.search`) when what was read is not enough.

The block SHALL NOT ask for a summary of the compacted window, and SHALL NOT ask for "the compact summary shown above". Either framing, combined with a replacing write, is exactly the loss this contract exists to prevent: the model does as it is told and the stored summary becomes the window.

This block is also the compaction re-arm of the read directive specified in "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist". A compacted context is, for that purpose, a fresh attachment to a pre-existing session, and the injection at the compaction boundary is the earliest point at which the model can act on it — so it carries the directive itself rather than depending on a later reminder firing or on a relaxed first-ensure marker.

Where a client has NO compaction hook, this requirement SHALL NOT cause one to be added. That client's coverage is its always-present protocol block (`mcp-api`, "The `instructions` block MUST state that a curated summary write replaces the stored value"), which carries the replacement and current-state obligations on every turn but no `memory.session_get` directive. That is a named gap, not a solved problem.

The block SHALL keep every obligation it already carries: the `10000` cap substring and the ≤600-byte budget of "Plugin-injected protocol nudges MUST surface the summary length cap", and one copy of the text shared by the clients that use it. A reworded block SHALL be re-measured, and the measurement SHALL be recorded rather than assumed: the rewritten block measures 530 bytes against the published 600.

#### Scenario: The block asks for the current whole state, after a read

- **WHEN** the post-compaction injection is emitted
- **THEN** it SHALL direct the model to call `memory.session_get` before writing
- **AND** it SHALL ask for the session's current complete state
- **AND** it SHALL state that the write replaces the stored value

#### Scenario: The block carries no window-only framing

- **WHEN** the same text is inspected
- **THEN** it SHALL NOT ask for a summary of the compacted window, of "what THIS window did", or of the host's own compact summary

#### Scenario: The block keeps its published obligations

- **WHEN** the emitted block is measured and grepped
- **THEN** it SHALL contain the substring `10000`
- **AND** it SHALL be ≤600 bytes in UTF-8

#### Scenario: One copy of the text

- **WHEN** the clients that inject at a compaction boundary are inspected
- **THEN** the text SHALL come from the shared fixture contract, byte-identical, with no per-client copy

## MODIFIED Requirements

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across every client

The save and session-summary nudge strings emitted per-turn by every client — Claude Code and Codex via `apps/plugin/scripts/prompt-nudge.sh`, opencode and Pi via the shared JS/TS module `apps/plugin/bin/rembric-plugin-core.mjs`, Hermes via `prefetch()` (`apps/plugin/.hermes-plugin/__init__.py`) — SHALL be sourced from the single shared contract `apps/plugin/test/nudge-fixtures.json` (`save`, `saveCore`, `summaryCore`, `summary`) and SHALL be byte-identical across clients. Bash and the shared JS/TS module embed the `rembric:`-prefixed `summary`/`save` verbatim; Hermes wraps `saveCore`/`summaryCore` in `<memory-hint>…</memory-hint>` per its established convention. No individual JS/TS client SHALL carry its own copy of these strings — there is one JS/TS implementation and every JS/TS client imports it, so a newly added client is byte-identical by construction rather than by review.

The shared text SHALL be phrased as a calibrated imperative:

- It SHALL direct the model to curate (`memory.session_summary`) / save (`memory.save`) as a required action when it applies, not a passive suggestion.
- It SHALL condition that action on real, memorable work having happened (a decision, fix, discovery, or files changed), preserving the model's discretion to skip trivial turns with nothing worth persisting — so the imperative does not induce vacuous summaries or noise saves.
- It SHALL NOT change the firing cadence, which is governed separately (summary on turn 1 and every `SUMMARY_NUDGE_EVERY`; save every `SAVE_NUDGE_EVERY`) and is unchanged by this requirement.

**The summary string SHALL NOT carry the write's replace-and-rewrite semantics, and that exclusion is a measured decision rather than an omission.** The string measures 259 UTF-8 bytes against its own published per-line cap of 260 (`claude-code-plugin`), and the firing-turn ceiling is ≤840 bytes against a measured worst case of 780, so any added clause costs a cap edit plus a re-measurement of three published aggregate figures, paid on turn 1 and every tenth turn in five clients. The semantics are delivered instead where the model is already reading a longer text about this tool and where there is measured headroom: the tool description (670 of 1900 characters) and `initialize.instructions` (916 of 1000), plus the two surfaces that fire exactly when a summary is about to be written — the compaction block and the end-of-turn rubric. A future change MAY move the clause here, and if it does it SHALL raise the per-line cap deliberately and re-measure every published figure that contains this string; it SHALL NOT append the clause and leave the caps as published.

**The summary string SHALL NOT assert, or deny, that a summary already exists for the session.** One string has to be true in both states, and a claim about state is the one thing a state-blind reminder cannot make.

#### Scenario: Shared nudge text is imperative and work-conditioned

- **WHEN** the `nudge-fixtures.json` `summary` and `save` strings are inspected
- **THEN** each SHALL read as a directive to act (imperative) AND SHALL reference the real-work condition (decision / fix / discovery / files changed), not merely an unconditional "call X now"

#### Scenario: Nudge text stays byte-identical across clients

- **WHEN** `nudge-fixtures.test.ts` compares the bash, shared JS/TS, and Python nudge sources against `nudge-fixtures.json`
- **THEN** all SHALL match the shared fixture (Python's `_SUMMARY_HINT` SHALL equal `<memory-hint>${summaryCore}</memory-hint>`, `_SAVE_HINT` SHALL equal `<memory-hint>${saveCore}</memory-hint>`; bash turn-1 output SHALL equal `summary`; bash turn-5 output SHALL equal `save`)
- **AND** the JS/TS arm SHALL read the shared module, not any individual client file

#### Scenario: A client carrying its own nudge copy fails the build

- **GIVEN** a JS/TS client file declares its own nudge string constant instead of importing it
- **WHEN** `pnpm test` runs
- **THEN** the single-implementation invariant SHALL fail, naming the offending file and line

#### Scenario: Cadence constants are unchanged

- **WHEN** the cadence constants are inspected across clients (`SUMMARY_NUDGE_EVERY`, `SAVE_NUDGE_EVERY`, and the `turn === 1` summary trigger)
- **THEN** they SHALL be unchanged by this requirement — only the sourcing mechanism changes

#### Scenario: The summary string is unchanged by the replace-and-rewrite contract

- **WHEN** the `summary` and `summaryCore` fixtures are compared against their values before this change
- **THEN** they SHALL be byte-identical, and each SHALL remain within its published per-line cap
- **AND** no published byte or token figure that contains this string SHALL need re-measuring

#### Scenario: The summary string makes no claim about whether a summary exists

- **WHEN** the string is inspected
- **THEN** it SHALL neither assert nor deny that the session already carries a curated summary

### Requirement: The summary reminder MUST be delivered at the end of the turn, and MUST NEVER interrupt

A reminder that a session owes a summary SHALL be delivered at the END of a turn as well as at its start. A reminder attached only to the start of a turn always arrives while there is more work to do, so it is advice about future behaviour; the end of the turn is the point at which the work of that turn is finished and the model can still act on it.

The reminder SHALL be delivered as non-interrupting feedback that continues the conversation. It SHALL NOT use the host's blocking decision. Two reasons: a memory server is an optional accessory to its host and MUST NOT be able to hold an agent's turn open, and a blocking reminder needs a loop guard whose absence on any one host would make the mechanism unsafe there. Non-interrupting feedback carries the same text and needs neither.

The host's end-of-turn event SHALL therefore carry TWO independent entries with different obligations:

- The existing raw-sync entry SHALL remain asynchronous. It is a pure side effect and SHALL NOT delay the turn.
- A second entry SHALL be synchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback to the turn at all. Wiring the reminder asynchronously forfeits it entirely.

**The reminder SHALL be rate-limited by the same per-session turn counter the start-of-turn nudge already uses, at the same cadence.** It SHALL NOT fire on every turn. The end-of-turn event fires once per turn, not once per session, so an unthrottled reminder would inject its payload into every turn of a long session — and the repository already owns exactly one mechanism for "remind every N turns". A second, independently-tuned cadence would be a second thing to keep in step with the first.

When the reminder fires, its payload SHALL carry the canonical summary structure in full (see `sessions`) AND the grounded facts extracted from the session, so the model summarises against evidence rather than recollection. This is the surface that carries the long form precisely because it has no length budget, unlike a tool description.

Because it is also the surface a model reads immediately before writing, the payload SHALL state that the write replaces the stored summary and SHALL ask for the session's current complete state, current first.

The entry SHALL NOT fire when the session has produced nothing worth summarising — a turn that only read or only talked. "Produced nothing" SHALL be decided from the session's own transcript, not from the server: no files written or edited and no commands run.

**That is the ONLY licensed silence, alongside the fail-open cases below.** The reminder SHALL NOT be suppressed because the session already carries a curated summary, and SHALL NOT derive that state from anywhere — not from the server, and not by scanning the transcript for a completed summary tool call. Suppressing it freezes whatever the first write said, because nothing afterwards ever asks the model to improve it, and it is exactly what makes a premature first summary permanent. The reason the suppression was defensible has also gone: a later curated write is recorded as a version row before it can displace anything (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"), so a redundant reminder can no longer cost stored text.

It SHALL NOT be required to know whether a curated summary already exists, and SHALL NOT make a request to find out. No read endpoint for a session exists — the HTTP surface offers only `POST .../summary` and `POST .../end` — so the reminder is cadence-gated and may fire on a session that has already been summarised. That is deliberate under-precision: the cost is one redundant reminder every N turns, and the alternative is new HTTP surface. A follow-up MAY add a read endpoint and narrow this; until it does, no requirement here SHALL assert the reminder consults server state.

That sentence is about the CLIENT. A model directed to read the stored summary before rewriting it (see "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist") calls the `memory.session_get` MCP tool itself; the client still asks the server nothing beyond the session-ensure it already makes.

**Fail-open is absolute.** On unparseable input, an unreadable or absent turn counter, a missing or unreadable transcript, an unavailable parser, or any unexpected error, the entry SHALL exit successfully and produce no output. Where a host requires a JSON object on every invocation, it SHALL emit an empty one rather than nothing. The failure mode of a missed reminder is a thinner summary; there SHALL be no failure mode in which the host is degraded.

#### Scenario: The reminder fires at the counter's cadence when a summary is owed

- **GIVEN** a session that has written or edited a file, or run a command, on a turn at which the shared counter's cadence fires
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL emit non-interrupting feedback carrying the canonical structure and the extracted facts
- **AND** it SHALL NOT emit an interrupting decision

#### Scenario: The reminder is silent on turns between cadence points

- **GIVEN** the same session on a turn at which the shared counter's cadence does not fire
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output

#### Scenario: The reminder does not consult the server

- **GIVEN** any session state, including one that already carries a curated summary
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL decide from the transcript and the counter alone, and SHALL make no request

#### Scenario: An already-curated session still gets the reminder, never silence

- **GIVEN** a session whose transcript shows a completed `memory.session_summary` call, on a turn at which the cadence fires and files were written
- **WHEN** the end-of-turn event fires
- **THEN** the reminder SHALL be emitted
- **AND** no code path SHALL inspect the transcript for a prior summary call in order to suppress it

#### Scenario: The rubric asks for the current whole state

- **WHEN** the emitted rubric text is inspected
- **THEN** it SHALL state that the write replaces the stored summary
- **AND** it SHALL ask for the session's current complete state, current first, rather than for what is new since the last write

#### Scenario: The transcript is missing or unreadable

- **GIVEN** an end-of-turn event whose payload names no transcript, or one that cannot be parsed
- **WHEN** the hook runs
- **THEN** it SHALL exit successfully with no output, and the turn SHALL complete normally

#### Scenario: The turn counter is unreadable

- **GIVEN** an environment in which the shared turn counter cannot be read or written
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output rather than fall back to reminding on every turn

#### Scenario: A session with nothing worth summarising

- **GIVEN** a session that wrote or edited no file and ran no command
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL produce no output
