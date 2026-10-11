## MODIFIED Requirements

### Requirement: A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist

A process whose FIRST `POST /api/<slug>/sessions` of its lifetime reports `created: false` attached to a session it did not author. It cannot know whether a curated summary is already stored, and the model driving it cannot see the turns that produced one. It SHALL therefore emit, once, a standalone line directing the model to read the stored summary (`memory.session_get_batch`) before its next curated write.

**What the line buys is the QUALITY of the rewrite AND the part of its safety the server cannot provide.** The server's own protection is preservation by OMISSION and nothing else (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"): a `##` section the write does not carry survives byte-identically, and a curated write carrying no `##` heading at all against a sectioned stored summary is refused outright. That covers the model which forgets a section and the model which collapses the document into one paragraph. It does NOT cover the model which carries a section and puts less under it — that write replaces the section and the previous bytes are retained nowhere.

The line closes exactly that residual: a model can only preserve what it can see, so directing it to read the stored summary first is what turns an in-section rewrite into a condensation instead of a substitution. Its absence is therefore no longer free, and this requirement SHALL NOT claim that it is. It remains a nudge and not a precondition — the server SHALL NOT gate a curated write on a prior read, because a model that never reads still writes a summary worth having for the sections it does carry.

The line SHALL direct `memory.session_get_batch({ ids: [sessionId] })` and consumption of the full `sessions[]` entry before a curated write.

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

1. Read the stored summary (`memory.session_get_batch({ ids: [sessionId] })`) from the full `sessions[]` entry.
2. Write the session's CURRENT COMPLETE state with `memory.session_summary` — what was just read, brought up to date with the surviving window — **and SHALL be told what the write does to the stored value, in terms that are true under the section-wise merge: each `##` section the write carries replaces its stored counterpart, and a section the write omits keeps its stored text. Sending a summary of the window alone therefore replaces every section the window happens to mention and silently leaves the rest stale.**
3. Recall further prior context (`memory.context` / `memory.search`) when what was read is not enough.

The rationale in clause 2 is a correction, not a reword, and the correction is recorded because the previous form is quoted elsewhere. This requirement previously argued "so sending the window alone stores the window alone", which was exactly true of a whole-document replacement and is true after `refine-session-summary-writes` only of a window carrying no `##` heading, or one carrying every stored heading. The obligation is unchanged — the block must state what the write does — and the danger it points at is unchanged in kind but different in shape: the loss is now silent staleness in the sections the window did not mention, rather than wholesale replacement.

The block SHALL NOT ask for a summary of the compacted window, and SHALL NOT ask for "the compact summary shown above". Either framing, combined with a merging write, still produces the loss this contract exists to prevent: the model does as it is told, the sections the window covers become the window, and the sections it does not cover go quietly out of date with nothing marking them.

This block is also the compaction re-arm of the read directive specified in "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist". A compacted context is, for that purpose, a fresh attachment to a pre-existing session, and the injection at the compaction boundary is the earliest point at which the model can act on it — so it carries the directive itself rather than depending on a later reminder firing or on a relaxed first-ensure marker.

Where a client has NO compaction hook, this requirement SHALL NOT cause one to be added. That client's coverage is its always-present protocol block (`mcp-api`, "The `instructions` block MUST state what a curated summary write replaces and what it keeps"), which carries the merge and current-state obligations on every turn but no `memory.session_get_batch` directive. That is a named gap, not a solved problem.

The block SHALL keep every obligation it already carries: the `10000` cap substring and one copy of the text shared by the clients that use it. It SHALL carry the exact canonical Markdown heading directive. **A reworded block SHALL be re-measured against the published ≤700-byte cap in the same commit as the wording**, and the measured value recorded. Measured on the shipped fixture after the merge correction: the `rembric:`-prefixed `postCompact` is **599 bytes** and the unprefixed `postCompactCore` is **590**, against the 683 bytes the direct-replacement wording measured and the 675 the pre-correction fixture measured.

#### Scenario: The block asks for the current whole state, after a read

- **WHEN** the post-compaction injection is emitted
- **THEN** it SHALL direct the model to call `memory.session_get_batch` before writing
- **AND** it SHALL ask for the session's current complete state
- **AND** it SHALL state that the `##` sections the write carries replace their stored counterparts and that omitted sections keep their stored text

#### Scenario: The block no longer claims a whole-document replacement

- **WHEN** the emitted block is inspected
- **THEN** it SHALL NOT state that the write REPLACES the stored value without qualification
- **AND** it SHALL NOT imply that a thin rewrite overwrites everything stored

#### Scenario: The block carries no window-only framing

- **WHEN** the same text is inspected
- **THEN** it SHALL NOT ask for a summary of the compacted window, of "what THIS window did", or of the host's own compact summary

#### Scenario: The block keeps its published obligations and its cap

- **WHEN** the emitted block is measured and grepped
- **THEN** it SHALL contain the substring `10000`
- **AND** it SHALL require the six canonical `##` headings on separate lines
- **AND** it SHALL be ≤700 bytes in UTF-8, with the measured value recorded alongside the wording

#### Scenario: One copy of the text

- **WHEN** the clients that inject at a compaction boundary are inspected
- **THEN** the text SHALL come from the shared fixture contract, byte-identical, with no per-client copy
